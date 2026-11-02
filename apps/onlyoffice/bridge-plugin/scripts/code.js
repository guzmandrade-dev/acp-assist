/*
 * ACP Assist Bridge v0.3 (apps/onlyoffice/bridge-plugin).
 * Dumb transport, same contract as the LibreOffice .oxt bridge: the
 * plugin carries JSON between the editor and the companion; ALL
 * intelligence lives in the companion. The companion owns the port —
 * this side only connects OUT (long-poll), so no discovery is needed.
 *
 * Wire surface (companion side):
 *   POST /bridge/hello   {plugin, version, editor}
 *   GET  /bridge/next    long-poll -> {id, op, args}
 *   POST /bridge/result  {id, ok, data|error}
 *   POST /bridge/event   {type, data}
 *
 * Ops (each edit = ONE callCommand = one undo step):
 *   ping, context, selection, insert, insertTop, insertAfter,
 *   rewriteAt, deleteAt, rewriteSelection, undo, journal
 *   cell (spreadsheet): writeCells, insertRows, insertCols
 *   slide (presentation): rewriteSlide, insertSlideAfter
 *
 * v0.3: all three editors are readable/editable (Writer since v0.1).
 * undo now reports {undone:false} honestly — asc_Undo via
 * executeCommand is a silent no-op (AGENTS.md rule 19), so the
 * companion always shows the Ctrl+Z hint.
 */
(function (window) {
    var DEFAULT_PORT = 8790;
    var POLL_MS = 2000;
    var journal = [];
    var editorType = null;
    var lastEventKey = null;
    var companion = null;

    function ui(msg, cls) {
        try {
            var logEl = document.getElementById("log");
            var d = document.createElement("div");
            if (cls) d.className = cls;
            d.textContent = new Date().toISOString().slice(11, 23) + " " + msg;
            logEl.appendChild(d);
            logEl.scrollTop = logEl.scrollHeight;
            if (logEl.childNodes.length > 200) logEl.removeChild(logEl.firstChild);
        } catch (e) { /* outside DOM context */ }
    }

    function status(msg, cls) {
        try {
            var el = document.getElementById("status");
            el.textContent = msg;
            el.className = cls || "";
        } catch (e) {}
    }

    function post(path, body) {
        return fetch(companion + path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        }).catch(function (e) {
            status("companion unreachable", "err");
            throw e;
        });
    }

    function norm(text) {
        return String(text).replace(/\r+/g, "").replace(/\n+$/, "");
    }

    function cmd(fn) {
        return new Promise(function (resolve) {
            window.Asc.plugin.callCommand(fn, false, false, function (v) {
                resolve(v);
            });
        });
    }

    function record(op, data) {
        data.at = new Date().toISOString();
        data.op = op;
        journal.push(data);
        if (journal.length > 100) journal.shift();
    }

    /** Normalize companion-provided paragraphs for the document context. */
    function normParas(paras) {
        return (paras || []).map(function (p) {
            return {
                style: p.style || null,
                runs: (p.runs || []).map(function (r) {
                    return { text: String(r.text), bold: !!r.bold, italic: !!r.italic, code: !!r.code };
                })
            };
        });
    }

    /*
     * Source of the paragraph-builder that runs INSIDE callCommand
     * (serialized — closures are not allowed there). Reads
     * Asc.scope.paras, builds ApiParagraphs with styles + inline runs,
     * and leaves them in `made` with `oDocument` bound.
     */
    var MAKE_PARAS_SRC =
        "var oDocument = Api.GetDocument();" +
        "var made = [];" +
        "for (var i = 0; i < Asc.scope.paras.length; i++) {" +
        "  var spec = Asc.scope.paras[i];" +
        "  var p = Api.CreateParagraph();" +
        "  if (spec.style) {" +
        "    var sName = spec.style === 'Preformatted Text' ? 'Code' :" +
        "      (spec.style === 'Quotations' ? 'Quote' : spec.style);" +
        "    try { var st = Api.GetStyle(sName); if (st) { p.SetStyle(st); } } catch (e2) {}" +
        "  }" +
        "  for (var r = 0; r < spec.runs.length; r++) {" +
        "    var run = spec.runs[r];" +
        "    var oRun = p.AddText(run.text);" +
        "    try {" +
        "      if (run.bold) { oRun.SetBold(true); }" +
        "      if (run.italic) { oRun.SetItalic(true); }" +
        "      if (run.code) { oRun.SetFontFamily('Consolas'); }" +
        "    } catch (e3) {}" +
        "  }" +
        "  made.push(p);" +
        "}";

    function rangeCheckSrc() {
        return "var count = oDocument.GetElementsCount();" +
            "if (Asc.scope.index < 0 || Asc.scope.index >= count) {" +
            "  return { error: 'index ' + Asc.scope.index + ' out of range (0..' + (count - 1) + ')' };" +
            "}";
    }

    /* ---- A1 <-> 0-based row/col (companion-side; plugin stays dumb) ---- */

    function colLetters(n) {
        var s = "";
        n = n + 1;
        while (n > 0) {
            var rem = (n - 1) % 26;
            s = String.fromCharCode(65 + rem) + s;
            n = Math.floor((n - 1) / 26);
        }
        return s;
    }

    function a1ToRC(a1) {
        var m = /^([A-Za-z]{1,4})([1-9][0-9]{0,6})$/.exec(String(a1 || ""));
        if (!m) return null;
        var col = 0;
        for (var i = 0; i < m[1].length; i++) {
            col = col * 26 + (m[1].charCodeAt(i) & 31);
        }
        return { row: parseInt(m[2], 10) - 1, col: col - 1 };
    }

    function rcToA1(row, col) {
        return colLetters(col) + (row + 1);
    }

    /* ---- editor detection ---- */

    function detectEditor() {
        return cmd(function () {
            try {
                if (typeof Api.GetSheets === "function" &&
                        Api.GetSheets().length > 0) return "cell";
            } catch (e) {}
            try {
                if (typeof Api.GetCurrentSlide === "function" &&
                        Api.GetCurrentSlide()) return "slide";
            } catch (e) {}
            return "word";
        });
    }

    /* ---- selection snapshot (executeMethod route) ---- */

    function selectionSnapshot() {
        return new Promise(function (resolve) {
            var out = {};
            var pending = 2;
            function finish() { if (!--pending) resolve(out); }
            try {
                window.Asc.plugin.executeMethod("GetSelectionType", [], function (t) {
                    out.selectionType = t; finish();
                });
            } catch (e) { out.selectionTypeErr = String(e); finish(); }
            try {
                window.Asc.plugin.executeMethod("GetSelectedText", [], function (t) {
                    out.selectedText = typeof t === "string" ? t.slice(0, 1000) : t;
                    finish();
                });
            } catch (e) { out.selectedTextErr = String(e); finish(); }
        });
    }

    /* ---- selection-rewrite HTML (PasteHtml carries the styles) ---- */

    function esc(s) {
        return String(s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function runHtml(run) {
        var t = esc(run.text);
        if (run.code) return "<code>" + t + "</code>";
        if (run.bold && run.italic) return "<b><i>" + t + "</i></b>";
        if (run.bold) return "<b>" + t + "</b>";
        if (run.italic) return "<i>" + t + "</i>";
        return t;
    }

    function paraHtml(spec) {
        var inner = (spec.runs || []).map(runHtml).join("");
        var tag = "p";
        if (spec.style === "Heading 1") tag = "h1";
        else if (spec.style === "Heading 2") tag = "h2";
        else if (spec.style === "Heading 3" || spec.style === "Heading 4") tag = "h3";
        else if (spec.style === "Code" || spec.style === "Preformatted Text") tag = "pre";
        else if (spec.style === "Quote" || spec.style === "Quotations") tag = "blockquote";
        return "<" + tag + ">" + inner + "</" + tag + ">";
    }

    /* ---- writer ops (one callCommand each) ---- */

    function requireWord() {
        if (editorType !== "word") {
            throw new Error("op not implemented for editor '" + editorType + "' yet");
        }
    }

    function requireEditor(type, op) {
        if (editorType !== type) {
            throw new Error("op '" + op + "' is not implemented for editor '" + editorType + "'");
        }
    }

    /*
     * Source of the shape-text reader that runs INSIDE callCommand:
     * returns the shape's paragraphs joined with \n (raw — the caller
     * normalizes the \r quirks).
     */
    var SHAPE_TEXT_SRC =
        "function shapeText(shape) {" +
        "  var content = shape.GetContent();" +
        "  if (!content) return '';" +
        "  var n = content.GetElementsCount();" +
        "  var out = [];" +
        "  for (var j = 0; j < n; j++) {" +
        "    var t = '';" +
        "    try { t = content.GetElement(j).GetText(); } catch (e) {}" +
        "    out.push(String(t));" +
        "  }" +
        "  return out.join('\\n');" +
        "}";

    /*
     * Source of the shape-text writer: replaces ALL paragraphs of the
     * shape's content with the given lines (one paragraph per line).
     */
    var SET_SHAPE_PARAS_SRC =
        "function setShapeParas(shape, lines) {" +
        "  var content = shape.GetContent();" +
        "  if (!content) return false;" +
        "  try {" +
        "    while (content.GetElementsCount() > 0) { content.RemoveElement(0); }" +
        "  } catch (e) {" +
        "    try { content.RemoveAllElements(); } catch (e2) {}" +
        "  }" +
        "  for (var i = 0; i < lines.length; i++) {" +
        "    var p = Api.CreateParagraph();" +
        "    p.AddText(lines[i]);" +
        "    content.AddElement(p);" +
        "  }" +
        "  return true;" +
        "}";

    /* ---- cell (spreadsheet) reads ---- */

    function cellContext() {
        return cmd(new Function(
            "var wb = Api.GetSheets();" +
            "var active = Api.GetActiveSheet();" +
            "var activeName = active.GetName();" +
            "function colLetters(n) {" +
            "  var s = ''; n = n + 1;" +
            "  while (n > 0) { var rem = (n - 1) % 26;" +
            "    s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }" +
            "  return s;" +
            "}" +
            "function a1(row, col) { return colLetters(col) + (row + 1); }" +
            "var sheets = [];" +
            "for (var i = 0; i < wb.length; i++) {" +
            "  var ws = wb[i];" +
            "  var nm = ''; try { nm = ws.GetName(); } catch (e) {}" +
            "  var used = '';" +
            "  try { var ur = ws.GetUsedRange(); if (ur) used = String(ur.GetAddress()); } catch (e2) {}" +
            "  sheets.push({ name: nm, used: used, active: nm === activeName });" +
            "}" +
            "var CAP_R = 200, CAP_C = 40;" +
            "var data = null, selection = null;" +
            "try {" +
            "  var ur2 = active.GetUsedRange();" +
            "  if (ur2) {" +
            "    var r0 = ur2.GetRow(), c0 = ur2.GetCol();" +
            "    var nr = ur2.GetRowsCount(), nc = ur2.GetColumnsCount();" +
            "    var rend = Math.min(nr, CAP_R), cend = Math.min(nc, CAP_C);" +
            "    var values = [], formulas = [];" +
            "    for (var r = 0; r < rend; r++) {" +
            "      var vrow = [], frow = [];" +
            "      for (var c = 0; c < cend; c++) {" +
            "        var cell = active.GetRangeByNumber(r0 + r, c0 + c);" +
            "        var v = ''; try { v = String(cell.GetValue()); } catch (e3) {}" +
            "        vrow.push(v);" +
            "        var f = ''; try { f = String(cell.GetFormula()); } catch (e4) {}" +
            "        frow.push(f);" +
            "      }" +
            "      values.push(vrow); formulas.push(frow);" +
            "    }" +
            "    data = { sheet: activeName," +
            "      range: a1(r0, c0) + ':' + a1(r0 + rend - 1, c0 + cend - 1)," +
            "      values: values, formulas: formulas," +
            "      truncated: nr > CAP_R || nc > CAP_C };" +
            "  }" +
            "} catch (e5) {}" +
            "try {" +
            "  var sel = active.GetSelection();" +
            "  if (sel) {" +
            "    var sr = sel.GetRow(), sc = sel.GetCol();" +
            "    var snr = sel.GetRowsCount(), snc = sel.GetColumnsCount();" +
            "    var srend = Math.min(snr, CAP_R), scend = Math.min(snc, CAP_C);" +
            "    var svals = [];" +
            "    for (var r2 = 0; r2 < srend; r2++) {" +
            "      var row2 = [];" +
            "      for (var c2 = 0; c2 < scend; c2++) {" +
            "        var v2 = '';" +
            "        try { v2 = String(active.GetRangeByNumber(sr + r2, sc + c2).GetValue()); } catch (e6) {}" +
            "        row2.push(v2);" +
            "      }" +
            "      svals.push(row2);" +
            "    }" +
            "    selection = { ranges: [String(sel.GetAddress())], anchor: a1(sr, sc)," +
            "      values: svals, truncated: snr > CAP_R || snc > CAP_C };" +
            "  }" +
            "} catch (e7) {}" +
            "return { sheets: sheets, data: data, selection: selection };"
        )).then(function (r) {
            r.editor = "cell";
            return r;
        });
    }

    /* ---- slide (presentation) reads ---- */

    function slideContext() {
        return cmd(new Function(
            SHAPE_TEXT_SRC +
            "var pres = Api.GetPresentation();" +
            "var count = pres.GetSlidesCount();" +
            "var cur = pres.GetCurSlideIndex();" +
            "var slides = [];" +
            "for (var i = 0; i < count && i < 200; i++) {" +
            "  var sl = pres.GetSlideByIndex(i);" +
            "  var title = null, bodyRaw = null;" +
            "  try {" +
            "    var ts = sl.GetDrawingsByPlaceholderType('title');" +
            "    if (!ts || !ts.length) ts = sl.GetDrawingsByPlaceholderType('ctrTitle');" +
            "    if (ts && ts.length) { var t = shapeText(ts[0]); title = t ? t : null; }" +
            "  } catch (e) {}" +
            "  try {" +
            "    var bs = sl.GetDrawingsByPlaceholderType('body');" +
            "    if (bs && bs.length) { var bt = shapeText(bs[0]); bodyRaw = bt ? bt : null; }" +
            "  } catch (e2) {}" +
            "  slides.push({ index: i, current: i === cur, title: title, bodyRaw: bodyRaw });" +
            "}" +
            "return { count: count, current: cur, slides: slides };"
        )).then(function (r) {
            // Normalize the \r quirks here (plain JS, not inside callCommand).
            r.slides = r.slides.map(function (s) {
                var body = s.bodyRaw ? norm(s.bodyRaw) : "";
                var lines = body ? body.split("\n").filter(function (l) { return l.trim(); }) : [];
                return {
                    index: s.index,
                    current: s.current,
                    title: s.title ? norm(s.title) : null,
                    bodyPreview: lines[0] || null,
                    bodyParas: lines.length,
                };
            });
            return selectionSnapshot().then(function (sel) {
                r.selectionText = sel.selectedText && String(sel.selectedText).trim()
                    ? norm(sel.selectedText) : null;
                r.editor = "slide";
                return r;
            });
        });
    }

    /* ---- cell row/col insertion (shared by insertRows/insertCols) ---- */

    function insertRowCol(args, kind) {
        var rc = a1ToRC(args.anchor);
        if (!rc) return Promise.reject(new Error("bad A1 anchor '" + args.anchor + "'"));
        Asc.scope.row = rc.row;
        Asc.scope.col = rc.col;
        var targetSrc = kind === "row"
            ? "var target = ws.GetRangeByNumber(Asc.scope.row, 0).GetEntireRow();" +
              "target.Insert('down');"
            : "var target = ws.GetRangeByNumber(0, Asc.scope.col).GetEntireColumn();" +
              "target.Insert('right');";
        return cmd(new Function(
            "var ws = Api.GetActiveSheet();" +
            targetSrc +
            "return {};"
        )).then(function (r) {
            r.anchor = args.anchor;
            record(kind === "row" ? "insertRows" : "insertCols", { anchor: args.anchor });
            return r;
        });
    }

    var OPS = {
        ping: function () {
            return Promise.resolve({ pong: true, editor: editorType });
        },

        /* One context read per editor type (ONE callCommand each). */
        context: function () {
            if (editorType === "cell") return cellContext();
            if (editorType === "slide") return slideContext();
            requireWord();
            return cmd(function () {
                var oDocument = Api.GetDocument();
                var count = oDocument.GetElementsCount();
                var texts = [];
                var styles = [];
                for (var i = 0; i < count && i < 500; i++) {
                    var el = oDocument.GetElement(i);
                    var t = "";
                    try { t = el.GetText(); } catch (e) {}
                    texts.push(String(t));
                    var s = null;
                    try { s = el.GetStyle().GetName(); } catch (e2) {}
                    styles.push(s);
                }
                return { paragraphs: count, texts: texts, styles: styles };
            }).then(function (r) {
                r.texts = r.texts.map(norm);
                return selectionSnapshot().then(function (sel) {
                    r.selection = sel;
                    r.editor = editorType;
                    return r;
                });
            });
        },

        selection: function () {
            return selectionSnapshot();
        },

        insert: function (args) {
            requireWord();
            Asc.scope.paras = normParas(args.paragraphs);
            return cmd(new Function(
                MAKE_PARAS_SRC +
                "oDocument.InsertContent(made);" +
                "return { elements: oDocument.GetElementsCount() };"
            )).then(function (r) {
                record("insert", { paragraphs: Asc.scope.paras.length });
                return r;
            });
        },

        insertTop: function (args) {
            requireWord();
            Asc.scope.paras = normParas(args.paragraphs);
            return cmd(new Function(
                MAKE_PARAS_SRC +
                "for (var k = made.length - 1; k >= 0; k--) { oDocument.AddElement(0, made[k]); }" +
                "return { elements: oDocument.GetElementsCount() };"
            )).then(function (r) {
                record("insertTop", { paragraphs: Asc.scope.paras.length });
                return r;
            });
        },

        insertAfter: function (args) {
            requireWord();
            Asc.scope.paras = normParas(args.paragraphs);
            Asc.scope.index = args.index;
            return cmd(new Function(
                MAKE_PARAS_SRC +
                rangeCheckSrc() +
                "for (var k = 0; k < made.length; k++) {" +
                "  oDocument.AddElement(Asc.scope.index + 1 + k, made[k]);" +
                "}" +
                "return { elements: oDocument.GetElementsCount() };"
            )).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("insertAfter", { index: args.index, paragraphs: Asc.scope.paras.length });
                return r;
            });
        },

        rewriteAt: function (args) {
            requireWord();
            Asc.scope.paras = normParas(args.paragraphs);
            Asc.scope.index = args.index;
            return cmd(new Function(
                MAKE_PARAS_SRC +
                rangeCheckSrc() +
                "var old = '';" +
                "try { old = oDocument.GetElement(Asc.scope.index).GetText(); } catch (e4) {}" +
                "oDocument.RemoveElement(Asc.scope.index);" +
                "for (var k = 0; k < made.length; k++) {" +
                "  oDocument.AddElement(Asc.scope.index + k, made[k]);" +
                "}" +
                "return { oldText: String(old), elements: oDocument.GetElementsCount() };"
            )).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("rewriteAt", { index: args.index, oldText: norm(r.oldText), paragraphs: Asc.scope.paras.length });
                return r;
            });
        },

        deleteAt: function (args) {
            requireWord();
            Asc.scope.index = args.index;
            return cmd(new Function(
                "var oDocument = Api.GetDocument();" +
                rangeCheckSrc() +
                "var old = '';" +
                "try { old = oDocument.GetElement(Asc.scope.index).GetText(); } catch (e4) {}" +
                "oDocument.RemoveElement(Asc.scope.index);" +
                "return { oldText: String(old), elements: oDocument.GetElementsCount() };"
            )).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("deleteAt", { index: args.index, oldText: norm(r.oldText) });
                return r;
            });
        },

        /* ---- cell (spreadsheet) ops (one callCommand each) ---- */

        writeCells: function (args) {
            requireEditor("cell", "writeCells");
            var rc = a1ToRC(args.anchor);
            if (!rc) return Promise.reject(new Error("bad A1 anchor '" + args.anchor + "'"));
            Asc.scope.row = rc.row;
            Asc.scope.col = rc.col;
            Asc.scope.rows = (args.rows || []).map(function (row) {
                return (row || []).map(function (c) { return String(c); });
            });
            return cmd(new Function(
                "var ws = Api.GetActiveSheet();" +
                "for (var r = 0; r < Asc.scope.rows.length; r++) {" +
                "  for (var c = 0; c < Asc.scope.rows[r].length; c++) {" +
                "    ws.GetRangeByNumber(Asc.scope.row + r, Asc.scope.col + c)" +
                "      .SetValue(Asc.scope.rows[r][c]);" +
                "  }" +
                "}" +
                "return { rows: Asc.scope.rows.length };"
            )).then(function (r) {
                record("writeCells", { anchor: args.anchor, rows: Asc.scope.rows.length });
                r.anchor = args.anchor;
                return r;
            });
        },

        insertRows: function (args) {
            requireEditor("cell", "insertRows");
            return insertRowCol(args, "row");
        },

        insertCols: function (args) {
            requireEditor("cell", "insertCols");
            return insertRowCol(args, "col");
        },

        /* ---- slide (presentation) ops (one callCommand each) ---- */

        rewriteSlide: function (args) {
            requireEditor("slide", "rewriteSlide");
            Asc.scope.index = args.index;
            Asc.scope.title = String(args.title || "");
            Asc.scope.body = (args.body || []).map(String);
            return cmd(new Function(
                SHAPE_TEXT_SRC +
                SET_SHAPE_PARAS_SRC +
                "var pres = Api.GetPresentation();" +
                "var sl = pres.GetSlideByIndex(Asc.scope.index);" +
                "if (!sl) return { error: 'slide index ' + Asc.scope.index + ' out of range' };" +
                "var ts = sl.GetDrawingsByPlaceholderType('title');" +
                "if (!ts || !ts.length) ts = sl.GetDrawingsByPlaceholderType('ctrTitle');" +
                "if (!ts || !ts.length) return { error: 'slide has no title placeholder' };" +
                "if (Asc.scope.title && !setShapeParas(ts[0], [Asc.scope.title]))" +
                "  return { error: 'title frame is not writable' };" +
                "if (Asc.scope.body.length) {" +
                "  var bs = sl.GetDrawingsByPlaceholderType('body');" +
                "  if (!bs || !bs.length) return { error: 'slide has no body placeholder' };" +
                "  if (!setShapeParas(bs[0], Asc.scope.body))" +
                "    return { error: 'body frame is not writable' };" +
                "}" +
                "return { count: pres.GetSlidesCount() };"
            )).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("rewriteSlide", { index: args.index, title: Asc.scope.title, bodyParas: Asc.scope.body.length });
                return r;
            });
        },

        insertSlideAfter: function (args) {
            requireEditor("slide", "insertSlideAfter");
            Asc.scope.index = args.index;
            Asc.scope.title = String(args.title || "");
            Asc.scope.body = (args.body || []).map(String);
            return cmd(new Function(
                SET_SHAPE_PARAS_SRC +
                "var pres = Api.GetPresentation();" +
                "var W = 12192000, H = 6858000;" +
                "try { W = pres.GetWidth(); H = pres.GetHeight(); } catch (e0) {}" +
                "var sl = Api.CreateSlide();" +
                "function mkShape(phType, x, y, w, h) {" +
                "  var fill = Api.CreateSolidFill(Api.RGB(255, 255, 255));" +
                "  var stroke = Api.CreateStroke(0, Api.CreateNoFill());" +
                "  var shape = Api.CreateShape('rect', w, h, fill, stroke);" +
                "  shape.SetPosition(x, y);" +
                "  shape.SetPlaceholder(Api.CreatePlaceholder(phType));" +
                "  sl.AddObject(shape);" +
                "  return shape;" +
                "}" +
                "var titleShape = mkShape('title', 457200, 457200, W - 914400, 1371600);" +
                "if (!setShapeParas(titleShape, [Asc.scope.title]))" +
                "  return { error: 'title frame is not writable' };" +
                "var bodyShape = mkShape('body', 457200, 2286000, W - 914400, H - 3200400);" +
                "if (Asc.scope.body.length) setShapeParas(bodyShape, Asc.scope.body);" +
                "pres.AddSlide(sl);" +
                "try { sl.MoveTo(Asc.scope.index); } catch (e1) {}" +
                "return { count: pres.GetSlidesCount(), insertedAt: Asc.scope.index };"
            )).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("insertSlideAfter", { index: args.index, title: Asc.scope.title, bodyParas: Asc.scope.body.length });
                return r;
            });
        },

        rewriteSelection: function (args) {
            // The editor's own paste route: PasteHtml replaces the active
            // selection and carries heading/bold/italic/code styling.
            var paras = normParas(args.paragraphs);
            var html = paras.map(paraHtml).join("");
            return new Promise(function (resolve, reject) {
                try {
                    window.Asc.plugin.executeMethod(
                        "PasteHtml", [html],
                        function () { resolve({ pasted: true }); }
                    );
                    // PasteHtml gives no failure signal; resolve via the
                    // timeout fallback when the callback never fires.
                    setTimeout(function () { resolve({ pasted: true }); }, 1500);
                } catch (e) {
                    reject(new Error("PasteHtml failed: " + e));
                }
            }).then(function (r) {
                record("rewriteSelection", { paragraphs: paras.length });
                return r;
            });
        },

        undo: function () {
            // Honest no-op (AGENTS.md rule 19): executeCommand asc_Undo
            // is a silent no-op in Desktop Editors, so report undone:false
            // — the companion shows the always-works Ctrl+Z hint instead.
            return Promise.resolve({ undone: false, reason: "no plugin undo API — use Ctrl+Z in the editor" });
        },

        journal: function () {
            return Promise.resolve({ entries: journal.slice().reverse() });
        }
    };

    /* ---- long-poll loop ---- */

    function pollOnce() {
        fetch(companion + "/bridge/next?wait=20")
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .then(function (job) {
                status("connected (" + editorType + ")", "ok");
                if (job && job.op) {
                    var p;
                    try {
                        var fn = OPS[job.op];
                        if (!fn) throw new Error("unknown op '" + job.op + "'");
                        p = fn(job.args || {});
                    } catch (e) {
                        p = Promise.reject(e);
                    }
                    p.then(function (data) {
                        return post("/bridge/result", {
                            id: job.id, ok: true, data: data
                        });
                    }).catch(function (e) {
                        return post("/bridge/result", {
                            id: job.id, ok: false, error: String(e && e.message ? e.message : e)
                        });
                    });
                }
                pollOnce();
            })
            .catch(function () {
                status("companion unreachable", "err");
                setTimeout(pollOnce, 3000);
            });
    }

    /* ---- selection event loop (poll; attachEvent never fires) ---- */

    function selectionTick() {
        selectionSnapshot().then(function (s) {
            var key = JSON.stringify(s);
            if (key !== lastEventKey) {
                lastEventKey = key;
                post("/bridge/event", { type: "selection-change", data: s });
            }
            setTimeout(selectionTick, POLL_MS);
        }).catch(function () {
            setTimeout(selectionTick, POLL_MS);
        });
    }

    /* ---- wiring ---- */

    function companionBase() {
        var portEl = document.getElementById("port");
        var port = DEFAULT_PORT;
        try {
            var stored = window.localStorage.getItem("acp-companion-port");
            if (stored) port = Number(stored) || DEFAULT_PORT;
        } catch (e) {}
        if (portEl && portEl.value) port = Number(portEl.value) || DEFAULT_PORT;
        return "http://127.0.0.1:" + port;
    }

    window.Asc.plugin.init = function () {
        companion = companionBase();
        detectEditor().then(function (t) {
            editorType = t;
            status("connecting (" + t + ")…");
            return post("/bridge/hello", {
                plugin: "acp-bridge", version: "0.3.0", editor: t
            });
        }).then(function () {
            pollOnce();
            selectionTick();
        }).catch(function () {
            status("companion unreachable", "err");
            setTimeout(function () { window.Asc.plugin.init(); }, 3000);
        });
    };

    document.addEventListener("DOMContentLoaded", function () {
        var portEl = document.getElementById("port");
        var btn = document.getElementById("b-reconnect");
        try {
            var stored = window.localStorage.getItem("acp-companion-port");
            if (stored && portEl) portEl.value = stored;
        } catch (e) {}
        if (btn) btn.addEventListener("click", function () {
            try {
                window.localStorage.setItem("acp-companion-port", String(portEl.value || DEFAULT_PORT));
            } catch (e) {}
            window.Asc.plugin.init();
        });
    });

    window.Asc.plugin.button = function () {};
})(window);
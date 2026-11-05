/*
 * ACP Assist Bridge v0.5.0 (apps/onlyoffice/bridge-plugin).
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
 *   rewriteAt, deleteAt, rewriteSelection, insertTable, undo, journal
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
    var initializing = false;
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
        return new Promise(function (resolve, reject) {
            // Safety timeout: a stuck callCommand REJECTS instead of
            // wedging the whole long-poll loop forever (verified live:
            // an unbounded clear loop froze the editor thread once) —
            // and never resolves as data: detectEditor used to assign
            // the timeout object to editorType, poisoning every op
            // with "editor '[object Object]'" (live-verified 2026-11-03).
            var settled = false;
            var timer = setTimeout(function () {
                if (!settled) { settled = true; reject(new Error("callCommand timeout (30s)")); }
            }, 30000);
            window.Asc.plugin.callCommand(fn, false, false, function (v) {
                if (!settled) { settled = true; clearTimeout(timer); resolve(v); }
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
            // Slide marker is Api.GetPresentation() — Api.GetCurrentSlide is
            // an ApiPresentation method, NOT global Api (verified live: a
            // presentation detected as "word" with the old probe).
            try {
                if (typeof Api.GetPresentation === "function" &&
                        Api.GetPresentation()) return "slide";
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
     * v0.4: each line is {t: text, st: {b,i,c,s,f}|null} — styled runs
     * (bold/italic/color hex/size pt/font family). Plain strings are
     * still accepted. RemoveAllElements first (documented); the
     * RemoveElement fallback is BOUNDED so a placeholder shape whose
     * count does not shrink can never spin forever (verified live: the
     * unbounded loop froze the editor's document thread once).
     */
    var SET_SHAPE_PARAS_SRC =
        "function hexRgb(h) {" +
        "  if (!/^[0-9a-fA-F]{6}$/.test(String(h))) return null;" +
        "  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];" +
        "}" +
        "function setShapeParas(shape, lines, forceBlack) {" +
        "  var content = shape.GetContent();" +
        "  if (!content) return false;" +
        "  var cleared = false;" +
        "  try { cleared = content.RemoveAllElements(); } catch (e0) { cleared = false; }" +
        "  if (!cleared) {" +
        "    for (var i = 0; i < 500; i++) {" +
        "      var n = 0;" +
        "      try { n = content.GetElementsCount(); } catch (e1) { break; }" +
        "      if (n <= 0) break;" +
        "      try { content.RemoveElement(0); } catch (e2) { break; }" +
        "    }" +
        "  }" +
        "  for (var j = 0; j < lines.length; j++) {" +
        "    var ln = lines[j];" +
        "    var text = '', st = null;" +
        "    if (ln !== null && ln !== undefined) {" +
        "      if (typeof ln === 'string') text = ln;" +
        "      else { text = String(ln.t == null ? '' : ln.t); st = ln.st || null; }" +
        "    }" +
        "    var p = Api.CreateParagraph();" +
        "    var run = p.AddText(text);" +
        // Run styling (v0.4): every setter is optional and guarded —
        // an unsupported property must not kill the whole write.
        "    if (run) {" +
        "      if (st && st.b) { try { run.SetBold(true); } catch (ea) {} }" +
        "      if (st && st.i) { try { run.SetItalic(true); } catch (eb) {} }" +
        "      if (st && st.s) { try { run.SetFontSize(st.s); } catch (ec) {} }" +
        "      if (st && st.f) { try { run.SetFontFamily(st.f); } catch (ed) {} }" +
        "      if (st && st.c) {" +
        "        var rgb = hexRgb(st.c);" +
        "        if (rgb) { try { run.SetFill(Api.CreateSolidFill(Api.RGB(rgb[0], rgb[1], rgb[2]))); } catch (ee) {} }" +
        "      } else if (forceBlack) {" +
        // Synthetic rect shapes render their text in a theme-default
        // color that came out WHITE on the white fill — invisible on
        // screen while API reads still returned it (live-verified
        // 2026-11-03). forceBlack pins black for those shapes only;
        // themed placeholders keep their theme color.
        "        try { run.SetColor(0, 0, 0); } catch (ef) {}" +
        "      }" +
        "    }" +
        // Push(element) is the one-arg append; AddElement takes (pos, el)
        // (verified live: AddElement(el) alone was a silent no-op).
        "    var ok = false;" +
        "    try { ok = content.Push(p); } catch (e3) { ok = false; }" +
        "    if (!ok) { try { content.AddElement(content.GetElementsCount(), p); ok = true; } catch (e4) {} }" +
        "    if (!ok) return false;" +
        "  }" +
        // Placeholder contents re-grow empty paragraphs around writes
        // (verified live: titles read back as "\n\n<text>"). Trim leading
        // empty paragraphs so the written text is the first paragraph.
        "  for (var k = 0; k < 500; k++) {" +
        "    if (content.GetElementsCount() <= lines.length) break;" +
        "    var el0 = null;" +
        "    try { el0 = content.GetElement(0); } catch (e5) { break; }" +
        "    if (!el0) break;" +
        "    var t0 = '';" +
        "    try { t0 = String(el0.GetText()); } catch (e6) {}" +
        "    if (t0.trim() !== '') break;" +
        "    try { content.RemoveElement(0); } catch (e7) { break; }" +
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
            // GetRow()/GetCol() are 1-based (verified live, AGENTS.md rule
            // 23a): a used range of A1:B2 reports row 1 / col 1.
            "try {" +
            "  var ur2 = active.GetUsedRange();" +
            "  if (ur2) {" +
            "    var r0 = Math.max(0, ur2.GetRow() - 1), c0 = Math.max(0, ur2.GetCol() - 1);" +
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
            "    var sr = Math.max(0, sel.GetRow() - 1), sc = Math.max(0, sel.GetCol() - 1);" +
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
            "  var title = null, bodyRaw = null, hasTitle = false, hasBody = false, images = 0;" +
            "  try {" +
            "    var ts = sl.GetDrawingsByPlaceholderType('title');" +
            "    if (!ts || !ts.length) ts = sl.GetDrawingsByPlaceholderType('ctrTitle');" +
            "    hasTitle = !!(ts && ts.length);" +
            "    if (hasTitle) { var t = shapeText(ts[0]); title = t ? t : null; }" +
            "  } catch (e) {}" +
            "  try {" +
            "    var bs = sl.GetDrawingsByPlaceholderType('body');" +
            "    hasBody = !!(bs && bs.length);" +
            "    if (hasBody) { var bt = shapeText(bs[0]); bodyRaw = bt ? bt : null; }" +
            "  } catch (e2) {}" +
            "  try { images = sl.GetAllImages().length; } catch (e3) { images = 0; }" +
            "  slides.push({ index: i, current: i === cur, title: title," +
            "    bodyRaw: bodyRaw, hasTitle: hasTitle, hasBody: hasBody, images: images });" +
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
                    hasTitle: !!s.hasTitle,
                    hasBody: !!s.hasBody,
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

        /* Companion-side slide lines are {text, style?} objects; map them
         * to the compact {t, st} wire the callCommand source reads
         * (strings still accepted for older companions). */
        function lineObj(l) {
            if (l === null || l === undefined) return { t: "" };
            if (typeof l === "string") return { t: l };
            var st = l.style || {};
            return {
                t: String(l.text == null ? "" : l.text),
                st: {
                    b: !!st.bold,
                    i: !!st.italic,
                    c: st.color ? String(st.color) : null,
                    // SetFontSize takes HALF-POINTS (hps); the companion's
                    // style prefix size= is in points (verified live: 44pt
                    // landed as 22pt before the x2).
                    s: st.size ? Math.round(Number(st.size) * 2) : null,
                    f: st.font ? String(st.font) : null,
                },
            };
        }

        function lineObjs(lines) {
            return (lines || []).map(lineObj);
        }

        /** Slide-index args resolver: null index = the current slide. */
        var SLIDE_BY_INDEX_SRC =
            "function slideByIndex(pres, idx) {" +
            "  var i = (idx === null || idx === undefined) ? pres.GetCurSlideIndex() : idx;" +
            "  var sl = pres.GetSlideByIndex(i);" +
            "  if (!sl) throw new Error('slide index ' + i + ' out of range');" +
            "  return sl;" +
            "}";

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
                var kinds = [];
                var tables = [];
                for (var i = 0; i < count && i < 500; i++) {
                    var el = oDocument.GetElement(i);
                    var kind = "paragraph";
                    try { kind = el.GetClassType(); } catch (e0) {}
                    kinds.push(kind);
                    var t = "";
                    try { t = el.GetText(); } catch (e) {}
                    texts.push(String(t));
                    var s = null;
                    try { s = el.GetStyle().GetName(); } catch (e2) {}
                    styles.push(s);
                    if (kind === "table") {
                        // compact preview: dims + first-row cells
                        var preview = [];
                        try {
                            var row0 = el.GetRow(0);
                            var nc = row0.GetCellsCount();
                            for (var c = 0; c < nc && c < 8; c++) {
                                preview.push(String(row0.GetCell(c).GetText()).replace(/[\\r\\n\\t]+/g, " ").trim());
                            }
                            tables.push({
                                index: i,
                                rows: el.Rows.length,
                                cols: el.GetColumnsCount(),
                                header: preview
                            });
                        } catch (e3) {
                            tables.push({ index: i, error: String(e3) });
                        }
                    }
                }
                var images = 0;
                try { images = oDocument.GetAllImages().length; } catch (e4) {}
                return { paragraphs: count, texts: texts, styles: styles, kinds: kinds, tables: tables, images: images };
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

        /* insertTable {index, rows, header}: build + fill + insert a table
         * in ONE callCommand (one undo step, rule 51). index is the
         * 0-based paragraph AFTER which the table lands (index+1 element
         * position; -1 = very start of the document). rows is string[][];
         * header shades the first row. CreateTable is empirically
         * (rows, cols) — rule 50. */
        insertTable: function (args) {
            requireWord();
            Asc.scope.index = args.index;
            Asc.scope.rows = (args.rows || []).map(function (row) {
                return (row || []).map(function (c) { return String(c); });
            });
            Asc.scope.header = !!args.header;
            return cmd(new Function(
                "var oDocument = Api.GetDocument();" +
                "var p = Asc.scope;" +
                "var nRow = p.rows.length;" +
                "var nCol = 0;" +
                "for (var r = 0; r < nRow; r++) { if (p.rows[r].length > nCol) nCol = p.rows[r].length; }" +
                "if (nRow < 1 || nCol < 1) return { error: 'empty table' };" +
                "var count0 = oDocument.GetElementsCount();" +
                "if (p.index < -1 || p.index >= count0) return { error: 'index ' + p.index + ' out of range (-1..' + (count0 - 1) + ')' };" +
                "var t = Api.CreateTable(nRow, nCol);" +  // (rows, cols) — rule 50
                "if (!t) return { error: 'CreateTable returned null' };" +
                "for (var r2 = 0; r2 < nRow; r2++) {" +
                "  var row = t.GetRow(r2);" +
                "  for (var c = 0; c < nCol; c++) {" +
                "    var cell = row.GetCell(c);" +
                "    var txt = (p.rows[r2][c] === undefined || p.rows[r2][c] === null) ? '' : String(p.rows[r2][c]);" +
                "    try { cell.AddText(txt); }" +
                "    catch (e1) { cell.GetContent().GetElement(0).AddText(txt); }" +
                "    if (p.header && r2 === 0) {" +
                "      try { cell.SetBackgroundColor(Api.RGB(230, 230, 230)); } catch (e2) {}" +
                "    }" +
                "  }" +
                "}" +
                "var pos = p.index + 1;" +
                "if (pos < 0) pos = 0;" +
                "if (pos > oDocument.GetElementsCount()) pos = oDocument.GetElementsCount();" +
                "var added = oDocument.AddElement(pos, t);" +
                "return { added: !!added, pos: pos, tables: oDocument.GetAllTables().length, elements: oDocument.GetElementsCount() };"
            )).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("insertTable", { index: args.index, rows: Asc.scope.rows.length });
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
            Asc.scope.title = lineObj(args.title);
            Asc.scope.body = lineObjs(args.body);
            return cmd(new Function(
                SET_SHAPE_PARAS_SRC +
                "var pres = Api.GetPresentation();" +
                "var sl = pres.GetSlideByIndex(Asc.scope.index);" +
                "if (!sl) return { error: 'slide index ' + Asc.scope.index + ' out of range' };" +
                // Look everything up FIRST; a missing frame must fail
                // BEFORE any write lands (no partial writes on error).
                "var ts = sl.GetDrawingsByPlaceholderType('title');" +
                "if (!ts || !ts.length) ts = sl.GetDrawingsByPlaceholderType('ctrTitle');" +
                "if ((!ts || !ts.length) && Asc.scope.title.t) {" +
                "  return { error: 'slide has no title placeholder' };" +
                "}" +
                "var bs = sl.GetDrawingsByPlaceholderType('body');" +
                "if ((!bs || !bs.length) && Asc.scope.body.length) {" +
                "  return { error: 'slide has no body placeholder' };" +
                "}" +
                "if (ts && ts.length && Asc.scope.title.t && !setShapeParas(ts[0], [Asc.scope.title]))" +
                "  return { error: 'title frame is not writable' };" +
                "if (bs && bs.length && Asc.scope.body.length && !setShapeParas(bs[0], Asc.scope.body))" +
                "  return { error: 'body frame is not writable' };" +
                "return { count: pres.GetSlidesCount() };"
            )).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("rewriteSlide", { index: args.index, title: Asc.scope.title.t, bodyParas: Asc.scope.body.length });
                return r;
            });
        },

        insertSlideAfter: function (args) {
            requireEditor("slide", "insertSlideAfter");
            Asc.scope.index = args.index;
            Asc.scope.title = lineObj(args.title);
            Asc.scope.body = lineObjs(args.body);
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
                "if (!setShapeParas(titleShape, [Asc.scope.title], true))" +
                "  return { error: 'title frame is not writable' };" +
                "var bodyShape = mkShape('body', 457200, 2286000, W - 914400, H - 3200400);" +
                "if (Asc.scope.body.length) setShapeParas(bodyShape, Asc.scope.body, true);" +
                "pres.AddSlide(sl);" +
                "try { sl.MoveTo(Asc.scope.index); } catch (e1) {}" +
                "return { count: pres.GetSlidesCount(), insertedAt: Asc.scope.index };"
            )).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("insertSlideAfter", { index: args.index, title: Asc.scope.title.t, bodyParas: Asc.scope.body.length });
                return r;
            });
        },

        /* ---- v0.4 design ops (one callCommand each; P5-probed live) ---- */

        insertImage: function (args) {
            requireEditor("slide", "insertImage");
            Asc.scope.p = {
                index: args.index == null ? null : Number(args.index),
                src: String(args.src || ""),
                x: args.x == null ? null : Number(args.x),
                y: args.y == null ? null : Number(args.y),
                w: args.w == null ? null : Number(args.w),
                h: args.h == null ? null : Number(args.h),
            };
            return cmd(new Function(
                SLIDE_BY_INDEX_SRC +
                "var p = Asc.scope.p;" +
                "var pres = Api.GetPresentation();" +
                "var sl = slideByIndex(pres, p.index);" +
                "var W = 12192000, H = 6858000;" +
                "try { W = pres.GetWidth(); H = pres.GetHeight(); } catch (e0) {}" +
                "var w = p.w != null ? p.w : Math.round(W * 0.2);" +
                "var h = p.h != null ? p.h : w;" +
                "var x = p.x != null ? p.x : Math.round((W - w) / 2);" +
                "var y = p.y != null ? p.y : Math.round((H - h) / 2);" +
                "var img = Api.CreateImage(p.src, w, h);" +
                "if (!img) return { error: 'CreateImage returned null' };" +
                "try { img.SetPosition(x, y); } catch (e1) {}" +
                "var added = sl.AddObject(img);" +
                "return { added: added, images: sl.GetAllImages().length };"
            )).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("insertImage", { src: String(args.src).slice(0, 120) });
                return r;
            });
        },

        setBackground: function (args) {
            requireEditor("slide", "setBackground");
            Asc.scope.p = {
                index: args.index == null ? null : Number(args.index),
                kind: String(args.kind || "solid"),
                c1: String(args.color || ""),
                c2: String(args.color2 || ""),
                src: String(args.src || ""),
            };
            return cmd(new Function(
                SLIDE_BY_INDEX_SRC +
                "function hexRgb(h) {" +
                "  if (!/^[0-9a-fA-F]{6}$/.test(String(h))) return null;" +
                "  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];" +
                "}" +
                "var p = Asc.scope.p;" +
                "var pres = Api.GetPresentation();" +
                "var sl = slideByIndex(pres, p.index);" +
                "var fill = null;" +
                "if (p.kind === 'solid') {" +
                "  var r1 = hexRgb(p.c1);" +
                "  if (!r1) return { error: 'invalid solid background color' };" +
                "  fill = Api.CreateSolidFill(Api.RGB(r1[0], r1[1], r1[2]));" +
                "} else if (p.kind === 'gradient') {" +
                "  var g1 = hexRgb(p.c1), g2 = hexRgb(p.c2);" +
                "  if (!g1 || !g2) return { error: 'invalid gradient background colors' };" +
                "  var gs1 = Api.CreateGradientStop(Api.RGB(g1[0], g1[1], g1[2]), 0);" +
                "  var gs2 = Api.CreateGradientStop(Api.RGB(g2[0], g2[1], g2[2]), 100000);" +
                "  fill = Api.CreateRadialGradientFill([gs1, gs2]);" +
                "} else if (p.kind === 'image') {" +
                "  if (!p.src) return { error: 'missing background image source' };" +
                "  fill = Api.CreateBlipFill(p.src, 'stretch');" +
                "} else {" +
                "  return { error: 'unknown background kind ' + p.kind };" +
                "}" +
                "if (!fill) return { error: 'background fill factory failed' };" +
                "var ok = sl.SetBackground(fill);" +
                "return { applied: ok, kind: p.kind };"
            )).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("setBackground", { index: Asc.scope.p.index, kind: Asc.scope.p.kind });
                return r;
            });
        },

        addNotes: function (args) {
            requireEditor("slide", "addNotes");
            Asc.scope.p = {
                index: args.index == null ? null : Number(args.index),
                text: String(args.text || ""),
            };
            return cmd(new Function(
                SLIDE_BY_INDEX_SRC +
                "var p = Asc.scope.p;" +
                "var pres = Api.GetPresentation();" +
                "var sl = slideByIndex(pres, p.index);" +
                "var ok = sl.AddNotesText(p.text);" +
                "return { applied: ok };"
            )).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("addNotes", { index: Asc.scope.p.index, chars: Asc.scope.p.text.length });
                return r;
            });
        },

        deleteSlide: function (args) {
            requireEditor("slide", "deleteSlide");
            Asc.scope.index = Number(args.index);
            return cmd(new Function(
                "var pres = Api.GetPresentation();" +
                "var count = pres.GetSlidesCount();" +
                "var idx = Asc.scope.index;" +
                "if (idx < 0 || idx >= count) return { error: 'slide index ' + idx + ' out of range' };" +
                "var ok = pres.GetSlideByIndex(idx).Delete();" +
                "return { applied: ok, slidesBefore: count, slidesAfter: pres.GetSlidesCount() };"
            )).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("deleteSlide", { index: Asc.scope.index, slidesAfter: r.slidesAfter });
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
        // The unreachable-retry timer and the Reconnect button can race
        // (init while an earlier init is mid-flight stacked extra poll/
        // selection loops and hung callCommands); one init at a time.
        if (initializing) return;
        initializing = true;
        companion = companionBase();
        detectEditor().then(function (t) {
            // Never trust the resolved value blindly: anything that is
            // not a known editor id is a failure (live-verified: a
            // timed-out cmd used to leave editorType as an OBJECT).
            if (t !== "word" && t !== "cell" && t !== "slide") {
                throw new Error("editor detection failed: " + String(t));
            }
            editorType = t;
            initializing = false;
            status("connecting (" + t + ")…");
            return post("/bridge/hello", {
                plugin: "acp-bridge", version: "0.4.2", editor: t
            });
        }).then(function () {
            pollOnce();
            selectionTick();
        }).catch(function () {
            initializing = false;
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
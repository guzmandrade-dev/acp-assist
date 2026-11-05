/*
 * ACP Assist Phase 0 probe plugin (apps/onlyoffice/spike).
 * Dumb transport: every probe outcome is POSTed to the companion at
 * http://127.0.0.1:8791 so results can be observed and driven from
 * outside the editor. No intelligence lives here on purpose.
 */
(function (window) {
    var COMPANION = "http://127.0.0.1:8791";
    var logEl = null;

    function ui(msg, cls) {
        try {
            if (!logEl) logEl = document.getElementById("log");
            var d = document.createElement("div");
            if (cls) d.className = cls;
            d.textContent = new Date().toISOString().slice(11, 23) + " " + msg;
            logEl.appendChild(d);
            logEl.scrollTop = logEl.scrollHeight;
        } catch (e) { /* UI unavailable during callCommand context */ }
    }

    function report(kind, payload) {
        payload = payload || {};
        payload.kind = kind;
        payload.at = new Date().toISOString();
        return fetch(COMPANION + "/report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        }).then(function (r) {
            ui("report " + kind + " -> HTTP " + r.status, r.ok ? "ok" : "err");
            return r;
        }).catch(function (e) {
            ui("report " + kind + " FAILED: " + e, "err");
        });
    }

    /* ---- P2: transport ---- */

    function ping() {
        var t0 = performance.now();
        fetch(COMPANION + "/ping").then(function (r) {
            return r.text().then(function (txt) {
                report("ping", {
                    ok: r.ok, status: r.status, body: txt,
                    ms: Math.round(performance.now() - t0),
                    origin: location.origin, protocol: location.protocol
                });
                ui("ping ok " + r.status, "ok");
            });
        }).catch(function (e) {
            report("ping", { ok: false, error: String(e), origin: location.origin });
            ui("ping FAILED: " + e, "err");
        });
    }

    function pollOnce() {
        // Long-poll: companion holds up to 20s until a command is queued.
        var ctl = new AbortController ? new AbortController() : null;
        fetch(COMPANION + "/probe?wait=20").then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        }).then(function (cmd) {
            if (cmd && cmd.type) {
                ui("cmd: " + cmd.type, "ok");
                report("cmd-ack", { type: cmd.type, id: cmd.id });
                runCommand(cmd).then(function (result) {
                    report("cmd-result", { type: cmd.type, id: cmd.id, result: result });
                }).catch(function (e) {
                    report("cmd-result", { type: cmd.type, id: cmd.id, error: String(e) });
                });
            }
            pollOnce();
        }).catch(function (e) {
            ui("poll err: " + e, "err");
            setTimeout(pollOnce, 3000);
        });
    }

    /* ---- command execution (driven externally via long-poll) ---- */

    function runCommand(cmd) {
        switch (cmd.type) {
            case "ping":       ping(); return Promise.resolve({ done: true });
            case "insertText": return insertText(cmd.text || "Hello from ACP probe.\n");
            case "readDoc":    return readDoc();
            case "selection":  return selectionSnapshot();
            /* ---- P5: slide design probes (2026-11-03) ---- */
            case "slideInfo":     return slideInfo();
            case "insertImage":   return insertImage(cmd.src, cmd.x, cmd.y, cmd.w, cmd.h);
            case "setBackground": return setBackground(cmd);
            case "applyTheme":    return applyTheme();
            case "styleTitle":    return styleTitle(cmd);
            case "applyLayout":   return applyLayout(cmd.index);
            case "deleteSlide":   return deleteSlide(cmd.index);
            case "addNotes":      return addNotes(cmd.text);
            case "setTransition": return setTransition();
            /* ---- P6: writer rich-content probes (2026-11-04) ---- */
            case "p6info":    return p6info();
            case "p6table":   return p6table(cmd);
            case "p6image":   return p6image(cmd);
            case "p6link":    return p6link(cmd);
            case "p6list":    return p6list(cmd);
            case "p6comment": return p6comment(cmd);
            case "p6break":   return p6break(cmd);
            case "p6undo":    return p6undo(cmd);
            case "p6read":    return p6read();
            default:           return Promise.reject(new Error("unknown command " + cmd.type));
        }
    }

    /* ---- P5: slide design probes (2026-11-03) -----------------------
     * Research probe for v0.4 "modern design + images" support: images,
     * backgrounds, custom themes, run styling, layouts, slide deletion,
     * notes, transitions. Every write probe is ONE callCommand = one
     * undo step; every loop is bounded (AGENTS rules 29/35); rendering
     * changes get a VISUAL check from the user, reads prove nothing.
     *
     * callCommand SERIALIZES the function source and evals it in the
     * document context - closure variables do NOT survive (found live
     * 2026-11-03: a wrapper referencing `fn` returned undefined). Every
     * P5 probe therefore passes a SELF-CONTAINED source built with
     * new Function(), args in Asc.scope - the same pattern as the
     * bridge plugin's ops.
     */

    var SAMPLE_IMG = "https://static.onlyoffice.com/assets/docs/samples/img/onlyoffice_logo.png";
    // 1x1 red PNG
    var RED_DOT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    var GUARD = "if (typeof Api === 'undefined' || typeof Api.GetPresentation !== 'function') return { error: 'not a presentation' };";
    var CUR_IDX = "var pres = Api.GetPresentation(); var idx = 0; try { idx = pres.GetCurSlideIndex(); } catch (e) {} var slide = pres.GetSlideByIndex(idx);";

    function slideInfo() {
        return cmd(new Function(
            GUARD +
            "var pres = Api.GetPresentation();" +
            "var out = { slides: pres.GetSlidesCount() };" +
            "try { out.width = pres.GetWidth(); out.height = pres.GetHeight(); } catch (e) {}" +
            "try { out.masters = pres.GetMastersCount(); } catch (e) { out.mastersErr = String(e); }" +
            "var master = null;" +
            "try { master = pres.GetMaster(0); } catch (e) { out.masterErr = String(e); }" +
            "if (master) {" +
            "  var layouts = [];" +
            "  for (var i = 0; i < 50; i++) {" +
            "    var lo = null;" +
            "    try { lo = master.GetLayout(i); } catch (e) { break; }" +
            "    if (!lo) break;" +
            "    layouts.push({ index: i, classType: (function () { try { return lo.GetClassType(); } catch (e) { return null; } })() });" +
            "  }" +
            "  out.layouts = layouts;" +
            "}" +
            "var slide = null;" +
            "try { slide = pres.GetSlideByIndex(0); } catch (e) { out.slideErr = String(e); }" +
            "if (slide) {" +
            "  out.hasApplyTheme = typeof slide.ApplyTheme === 'function';" +
            "  out.hasApplyLayout = typeof slide.ApplyLayout === 'function';" +
            "  out.hasSetBackground = typeof slide.SetBackground === 'function';" +
            "  out.hasDelete = typeof slide.Delete === 'function';" +
            "  out.hasAddNotes = typeof slide.AddNotesText === 'function';" +
            "  out.hasGetSlideShowTransition = typeof slide.GetSlideShowTransition === 'function';" +
            "  out.hasSetSlideShowTransition = typeof slide.SetSlideShowTransition === 'function';" +
            "  try { var bg = slide.GetBackground(); out.bgClassType = bg ? bg.GetClassType() : null; } catch (e) { out.bgErr = String(e); }" +
            "  try { var th = slide.GetTheme(); out.themeClassType = th ? th.GetClassType() : null; } catch (e) { out.themeErr = String(e); }" +
            "  try { var lo2 = slide.GetLayout(); out.slideLayoutClassType = lo2 ? lo2.GetClassType() : null; } catch (e) {}" +
            "}" +
            "out.hasCreateImage = typeof Api.CreateImage === 'function';" +
            "out.hasCreateBlipFill = typeof Api.CreateBlipFill === 'function';" +
            "out.hasCreateTheme = typeof Api.CreateTheme === 'function';" +
            "out.hasCreateThemeColorScheme = typeof Api.CreateThemeColorScheme === 'function';" +
            "out.hasCreateThemeFormatScheme = typeof Api.CreateThemeFormatScheme === 'function';" +
            "out.hasCreateThemeFontScheme = typeof Api.CreateThemeFontScheme === 'function';" +
            "out.hasCreateGradientStop = typeof Api.CreateGradientStop === 'function';" +
            "return out;"
        ));
    }

    function insertImage(src, x, y, w, h) {
        Asc.scope.p = {
            src: src === "red" ? RED_DOT : (src || SAMPLE_IMG),
            x: Number(x) || 600000, y: Number(y) || 600000,
            w: Number(w) || 1800000, h: Number(h) || 1800000
        };
        return cmd(new Function(
            GUARD +
            "var p = Asc.scope.p;" +
            CUR_IDX +
            "var img = Api.CreateImage(p.src, p.w, p.h);" +
            "if (!img) return { error: 'CreateImage returned null' };" +
            "try { img.SetPosition(p.x, p.y); } catch (e) {}" +
            "var added = slide.AddObject(img);" +
            "return { added: added, images: slide.GetAllImages().length, slideIndex: idx, src: String(p.src).slice(0, 80) };"
        ));
    }

    function setBackground(spec) {
        Asc.scope.p = spec || {};
        return cmd(new Function(
            GUARD +
            "var p = Asc.scope.p;" +
            CUR_IDX +
            "var fill = null;" +
            "var kind = p.kind || 'solid';" +
            "if (kind === 'solid') { fill = Api.CreateSolidFill(Api.RGB(230, 240, 255)); }" +
            "else if (kind === 'gradient') {" +
            "  var gs1 = Api.CreateGradientStop(Api.RGB(255, 213, 191), 0);" +
            "  var gs2 = Api.CreateGradientStop(Api.RGB(255, 111, 61), 100000);" +
            "  fill = Api.CreateRadialGradientFill([gs1, gs2]);" +
            "} else if (kind === 'image') { fill = Api.CreateBlipFill(p.src || 'https://static.onlyoffice.com/assets/docs/samples/img/presentation_axe.png', 'stretch'); }" +
            "else { return { error: 'unknown kind ' + kind }; }" +
            "if (!fill) return { error: 'fill factory returned null for kind ' + kind };" +
            "var ok = slide.SetBackground(fill);" +
            "var bgClass = null;" +
            "try { var bg = slide.GetBackground(); bgClass = bg ? bg.GetClassType() : null; } catch (e) {}" +
            "return { applied: ok, kind: kind, bgClassType: bgClass };"
        ));
    }

    function applyTheme() {
        return cmd(new Function(
            GUARD +
            CUR_IDX +
            "var master = pres.GetMaster(0);" +
            "var colorScheme = Api.CreateThemeColorScheme([" +
            "  Api.RGB(255, 111, 61), Api.RGB(51, 51, 51), Api.RGB(230, 179, 117)," +
            "  Api.RGB(235, 235, 235), Api.RGB(163, 21, 21), Api.RGB(128, 43, 43)," +
            "  Api.RGB(0, 0, 0), Api.RGB(128, 128, 128), Api.RGB(176, 196, 222)," +
            "  Api.RGB(65, 105, 225), Api.RGB(255, 255, 255), Api.RGB(255, 213, 191)" +
            "], 'ACP probe color scheme');" +
            "var gs1 = Api.CreateGradientStop(Api.RGB(255, 213, 191), 0);" +
            "var gs2 = Api.CreateGradientStop(Api.RGB(255, 111, 61), 100000);" +
            "var fill1 = Api.CreateRadialGradientFill([gs1, gs2]);" +
            "var fill2 = Api.CreatePatternFill('dashDnDiag', Api.RGB(255, 111, 61), Api.RGB(51, 51, 51));" +
            "var fill3 = Api.CreateSolidFill(Api.RGB(255, 111, 61));" +
            "var stroke1 = Api.CreateStroke(1 * 36000, fill1);" +
            "var stroke2 = Api.CreateStroke(1 * 36000, fill2);" +
            "var stroke3 = Api.CreateStroke(1 * 36000, fill3);" +
            "var formatScheme = Api.CreateThemeFormatScheme([fill1, fill2, fill3], [fill1, fill2, fill3], [stroke1, stroke2, stroke3], 'ACP probe format scheme');" +
            "var fontScheme = Api.CreateThemeFontScheme('Georgia', 'Noto Sans Simplified Chinese', 'Arabic', 'Georgia', 'Noto Serif Simplified Chinese', 'Arabic', 'ACP probe font scheme');" +
            "var theme = Api.CreateTheme('ACP Probe Theme', master, colorScheme, formatScheme, fontScheme);" +
            "if (!theme) return { error: 'CreateTheme returned null' };" +
            "var ok = slide.ApplyTheme(theme);" +
            "return { applied: ok, themeName: 'ACP Probe Theme' };"
        ));
    }

    function styleTitle(spec) {
        Asc.scope.p = spec || {};
        return cmd(new Function(
            GUARD +
            "var p = Asc.scope.p;" +
            CUR_IDX +
            "var ts = slide.GetDrawingsByPlaceholderType('title');" +
            "if (!ts || !ts.length) return { error: 'no title placeholder on this slide' };" +
            "var shape = ts[0];" +
            "var content = shape.GetContent();" +
            "if (!content) return { error: 'title shape has no content' };" +
            "var cleared = false;" +
            "try { cleared = content.RemoveAllElements(); } catch (e) { cleared = false; }" +
            "if (!cleared) {" +
            "  for (var i = 0; i < 500; i++) {" +
            "    var n = 0;" +
            "    try { n = content.GetElementsCount(); } catch (e1) { break; }" +
            "    if (n <= 0) break;" +
            "    try { content.RemoveElement(0); } catch (e2) { break; }" +
            "  }" +
            "}" +
            "var para = Api.CreateParagraph();" +
            "var run = Api.CreateRun();" +
            "run.AddText(p.text || 'Styled Title');" +
            "try { run.SetFontFamily('Georgia'); } catch (e) {}" +
            "try { run.SetFontSize(40); } catch (e) {}" +
            "try { run.SetBold(true); } catch (e) {}" +
            "try { run.SetFill(Api.CreateSolidFill(Api.RGB(255, 111, 61))); } catch (e) {}" +
            "para.AddElement(run);" +
            "var pushed = false;" +
            "try { pushed = content.Push(para); } catch (e3) { pushed = false; }" +
            "if (!pushed) { try { content.AddElement(content.GetElementsCount(), para); pushed = true; } catch (e4) {} }" +
            "return { pushed: pushed, text: p.text || 'Styled Title' };"
        ));
    }

    function applyLayout(index) {
        Asc.scope.p = { index: Number(index) || 0 };
        return cmd(new Function(
            GUARD +
            "var p = Asc.scope.p;" +
            CUR_IDX +
            "var master = pres.GetMaster(0);" +
            "var layout = master.GetLayout(p.index);" +
            "if (!layout) return { error: 'no layout at index ' + p.index };" +
            "var ok = slide.ApplyLayout(layout);" +
            "return { applied: ok, layoutIndex: p.index, slideIndex: idx };"
        ));
    }

    function deleteSlide(index) {
        Asc.scope.p = { index: Number(index) };
        return cmd(new Function(
            GUARD +
            "var p = Asc.scope.p;" +
            "var pres = Api.GetPresentation();" +
            "var count = pres.GetSlidesCount();" +
            "if (count <= 0) return { error: 'no slides' };" +
            "var target = (p.index >= 0 && p.index < count) ? p.index : count - 1;" +
            "var ok = pres.GetSlideByIndex(target).Delete();" +
            "return { applied: ok, deletedIndex: target, slidesBefore: count, slidesAfter: pres.GetSlidesCount() };"
        ));
    }

    function addNotes(text) {
        Asc.scope.p = { text: String(text || "Speaker notes from the ACP probe.") };
        return cmd(new Function(
            GUARD +
            "var p = Asc.scope.p;" +
            CUR_IDX +
            "var ok = slide.AddNotesText(p.text);" +
            "return { applied: ok, slideIndex: idx, text: p.text };"
        ));
    }

    function setTransition() {
        return cmd(new Function(
            GUARD +
            CUR_IDX +
            "var out = {" +
            "  hasGetSlideShowTransition: typeof slide.GetSlideShowTransition === 'function'," +
            "  hasSetSlideShowTransition: typeof slide.SetSlideShowTransition === 'function'," +
            "  hasApiCreateSlideShowTransition: typeof Api.CreateSlideShowTransition === 'function'" +
            "};" +
            "try { var tr = slide.GetSlideShowTransition(); out.currentClassType = tr ? tr.GetClassType() : null; } catch (e) { out.getErr = String(e); }" +
            "if (out.hasSetSlideShowTransition) {" +
            "  try {" +
            "    var tr2 = out.hasApiCreateSlideShowTransition ? Api.CreateSlideShowTransition() : null;" +
            "    if (tr2) { out.createdClassType = tr2.GetClassType(); out.applied = slide.SetSlideShowTransition(tr2); }" +
            "    else { out.applied = false; out.note = 'no CreateSlideShowTransition factory'; }" +
            "  } catch (e) { out.setErr = String(e); }" +
            "}" +
            "return out;"
        ));
    }

    /* ---- P6: Writer rich-content probes (2026-11-04) ------------------
     * Tables / images / hyperlinks / numbering / comments / breaks in a
     * WORD document. Same hygiene as P5: one callCommand per op, bounded
     * loops, self-contained new Function(src) sources (rule 39), args via
     * Asc.scope. WORD_GUARD rejects non-word editors cleanly.
     */

    var WORD_GUARD = "if (typeof Api === 'undefined' || typeof Api.GetDocument !== 'function') return { error: 'not a word document' };";

    function p6info() {
        return cmd(new Function(
            WORD_GUARD +
            "var doc = Api.GetDocument();" +
            "var p = doc.GetElement ? doc.GetElement(0) : null;" +
            "function t(o, n) { try { return typeof o[n]; } catch (e) { return 'err'; } }" +
            "return {" +
            "  Api: { CreateTable: t(Api, 'CreateTable'), CreateImage: t(Api, 'CreateImage'), CreateNumbering: t(Api, 'CreateNumbering'), CreateChart: t(Api, 'CreateChart'), CreateShape: t(Api, 'CreateShape'), CreateParagraph: t(Api, 'CreateParagraph'), CreateRun: t(Api, 'CreateRun'), AddComment: t(Api, 'AddComment'), RGB: t(Api, 'RGB'), CreateSolidFill: t(Api, 'CreateSolidFill') }," +
            "  doc: { Push: t(doc, 'Push'), AddElement: t(doc, 'AddElement'), InsertContent: t(doc, 'InsertContent'), CreateNumbering: t(doc, 'CreateNumbering'), GetAllTables: t(doc, 'GetAllTables'), GetAllImages: t(doc, 'GetAllImages'), GetAllParagraphs: t(doc, 'GetAllParagraphs'), RemoveElement: t(doc, 'RemoveElement') }," +
            "  para: p ? { AddDrawing: t(p, 'AddDrawing'), AddHyperlink: t(p, 'AddHyperlink'), AddComment: t(p, 'AddComment'), AddPageBreak: t(p, 'AddPageBreak'), AddColumnBreak: t(p, 'AddColumnBreak'), AddLineBreak: t(p, 'AddLineBreak'), SetNumbering: t(p, 'SetNumbering'), GetNumbering: t(p, 'GetNumbering'), SetStyle: t(p, 'SetStyle'), GetStyle: t(p, 'GetStyle'), AddElement: t(p, 'AddElement'), GetElement: t(p, 'GetElement'), GetElementsCount: t(p, 'GetElementsCount'), GetClassType: t(p, 'GetClassType') } : null," +
            "  elements: doc.GetElementsCount()" +
            "};"
        ));
    }

    function p6table(spec) {
        Asc.scope.p = spec || {};
        return cmd(new Function(
            WORD_GUARD +
            "var p = Asc.scope.p;" +
            "var doc = Api.GetDocument();" +
            "var nCol = Number(p.cols) || 3, nRow = Number(p.rows) || 2;" +
            "var t = Api.CreateTable(nCol, nRow);" +
            "if (!t) return { error: 'CreateTable null' };" +
            "var out = { colsArg: nCol, rowsArg: nRow };" +
            "try { out.cols = t.GetColumnsCount(); } catch (e) { out.colsErr = String(e); }" +
            "try { out.rows = t.Rows.length; } catch (e) { out.rowsErr = String(e); }" +
            "try { out.hasSetTableBorderTop = typeof t.SetTableBorderTop; out.hasSetBorders = typeof t.SetBorders; out.hasSetWidth = typeof t.SetWidth; out.hasSetTableLook = typeof t.SetTableLook; } catch (e) {}" +
            // fill every cell with row,col text
            "for (var r = 0; r < nRow && r < 20; r++) {" +
            "  var row = t.GetRow(r);" +
            "  for (var c = 0; c < nCol && c < 20; c++) {" +
            "    var cell = row.GetCell(c);" +
            "    var txt = 'r' + r + 'c' + c;" +
            "    var done = false;" +
            "    try { cell.AddText(txt); done = true; } catch (e1) {" +
            "      try { var content = cell.GetContent(); content.GetElement(0).AddText(txt); done = true; } catch (e2) { out.fillErr = String(e2); }" +
            "    }" +
            "    if (r === 0 && c === 0) {" +
            "      try { cell.SetBackgroundColor(Api.RGB(255, 230, 180)); out.shade = 'SetBackgroundColor ok'; } catch (e3) {" +
            "        try { cell.SetShd('FFE6B4'); out.shade = 'SetShd hex ok'; } catch (e4) { out.shadeErr = String(e4); }" +
            "      }" +
            "      try { cell.SetVerticalAlign('top'); out.valign = true; } catch (e5) {}" +
            "    }" +
            "  }" +
            "}" +
            // insert at position (after paragraph p.pos if given) else append
            "var pos = (typeof p.pos === 'number') ? p.pos : doc.GetElementsCount();" +
            "var added = false;" +
            "try { added = doc.AddElement(pos, t); } catch (e6) {" +
            "  try { added = doc.Push(t); out.fallback = 'Push'; } catch (e7) { out.addErr = String(e7); }" +
            "}" +
            "out.added = added; out.pos = pos;" +
            "try { out.tablesInDoc = doc.GetAllTables().length; } catch (e8) {}" +
            "try { out.cell00 = t.GetRow(0).GetCell(0).GetText(); } catch (e9) { out.cellErr = String(e9); }" +
            "try { out.classType = t.GetClassType(); } catch (e10) {}" +
            "try { out.elements = doc.GetElementsCount(); } catch (e11) {}" +
            "return out;"
        ));
    }

    function p6image(spec) {
        Asc.scope.p = { src: (spec && spec.src === "red") ? RED_DOT : ((spec && spec.src) || SAMPLE_IMG) };
        return cmd(new Function(
            WORD_GUARD +
            "var p = Asc.scope.p;" +
            "var doc = Api.GetDocument();" +
            "var img = Api.CreateImage(p.src, 2 * 36000, 2 * 36000);" +
            "if (!img) return { error: 'CreateImage null' };" +
            "var out = { imgClass: (function(){try{return img.GetClassType();}catch(e){return null;}})() };" +
            "var para = Api.CreateParagraph();" +
            "var added = false;" +
            "try { added = para.AddDrawing(img); } catch (e1) { out.addErr = String(e1); }" +
            "try { doc.Push(para); } catch (e2) { out.pushErr = String(e2); }" +
            "try { out.imagesInDoc = doc.GetAllImages().length; } catch (e3) { out.imgsErr = String(e3); }" +
            "try { out.drawingsOnPara = para.GetAllDrawings ? para.GetAllDrawings().length : 'n/a'; } catch (e4) {}" +
            "out.added = added; out.elements = doc.GetElementsCount();" +
            "return out;"
        ));
    }

    function p6link(spec) {
        Asc.scope.p = { url: (spec && spec.url) || "https://example.com", text: (spec && spec.text) || "example link" };
        return cmd(new Function(
            WORD_GUARD +
            "var p = Asc.scope.p;" +
            "var doc = Api.GetDocument();" +
            "var para = Api.CreateParagraph();" +
            "para.AddText('see ');" +
            "var hl = null;" +
            "try { hl = para.AddHyperlink(p.url, p.text); } catch (e1) { return { error: 'AddHyperlink: ' + e1 }; }" +
            "var out = { hlClass: null, paraText: null, nEls: null };" +
            "try { out.hlClass = hl ? hl.GetClassType() : null; } catch (e2) {}" +
            "try { out.paraText = para.GetText(); } catch (e3) {}" +
            "try { out.nEls = para.GetElementsCount();" +
            "  var kinds = [];" +
            "  for (var i = 0; i < out.nEls && i < 20; i++) { try { kinds.push(para.GetElement(i).GetClassType()); } catch (e4) {} }" +
            "  out.elKinds = kinds; } catch (e5) {}" +
            "doc.Push(para);" +
            "out.elements = doc.GetElementsCount();" +
            "return out;"
        ));
    }

    function p6list(spec) {
        Asc.scope.p = { kind: (spec && spec.kind) || "bullet" };
        return cmd(new Function(
            WORD_GUARD +
            "var p = Asc.scope.p;" +
            "var doc = Api.GetDocument();" +
            "var out = { kind: p.kind };" +
            "var num = null;" +
            "try { num = doc.CreateNumbering(p.kind); } catch (e1) {" +
            "  try { num = Api.CreateNumbering(p.kind); } catch (e2) { out.numErr = String(e2); }" +
            "}" +
            "if (!num) return out;" +
            "try { out.numClass = num.GetClassType(); } catch (e3) {}" +
            "var lvl = null;" +
            "try { lvl = num.GetLevel(0); out.lvlClass = lvl ? lvl.GetClassType() : null; } catch (e4) { out.lvlErr = String(e4); }" +
            "var para = Api.CreateParagraph();" +
            "para.AddText('list item one');" +
            "var set = false;" +
            "try { set = para.SetNumbering(lvl); } catch (e5) { out.setErr = String(e5); }" +
            "out.set = set;" +
            "doc.Push(para);" +
            "try { out.hasGetNumbering = typeof para.GetNumbering; } catch (e6) {}" +
            "return out;"
        ));
    }

    function p6comment(spec) {
        Asc.scope.p = { text: (spec && spec.text) || "P6 probe comment" };
        return cmd(new Function(
            WORD_GUARD +
            "var p = Asc.scope.p;" +
            "var doc = Api.GetDocument();" +
            "var para = Api.CreateParagraph();" +
            "para.AddText('comment target');" +
            "doc.Push(para);" +
            "var out = { paraAddComment: typeof para.AddComment, apiAddComment: typeof Api.AddComment, docAddComment: typeof doc.AddComment };" +
            "var c = null;" +
            "try { c = para.AddComment(p.text); } catch (e1) { out.paraErr = String(e1); }" +
            "if (!c) { try { c = Api.AddComment(para, p.text); } catch (e2) { out.apiErr = String(e2); } }" +
            "out.commentClass = null;" +
            "try { out.commentClass = c ? c.GetClassType() : null; } catch (e3) {}" +
            "try { var all = doc.GetAllComments ? doc.GetAllComments() : null; out.comments = all ? all.length : 'n/a'; } catch (e4) { out.commentsErr = String(e4); }" +
            "return out;"
        ));
    }

    function p6break(spec) {
        return cmd(new Function(
            WORD_GUARD +
            "var doc = Api.GetDocument();" +
            "var para = Api.CreateParagraph();" +
            "var out = {};" +
            "para.AddText('before-line');" +
            "try { para.AddLineBreak(); out.line = true; } catch (e1) { out.lineErr = String(e1); }" +
            "para.AddText('after-line');" +
            "try { para.AddPageBreak(); out.page = true; } catch (e2) { out.pageErr = String(e2); }" +
            "try { para.AddColumnBreak(); out.col = true; } catch (e3) { out.colErr = String(e3); }" +
            "doc.Push(para);" +
            "try { out.text = para.GetText(); } catch (e4) {}" +
            "out.elements = doc.GetElementsCount();" +
            "return out;"
        ));
    }

    function p6undo(spec) {
        // Does executeMethod('Undo') work from a plugin? Count steps to revert.
        Asc.scope.p = { max: Number((spec && spec.max) || 10) };
        return new Promise(function (resolve) {
            var out = { max: Asc.scope.p.max, steps: [] };
            function readState(cb) {
                cmd(new Function(
                    WORD_GUARD +
                    "var doc = Api.GetDocument();" +
                    "var tables = 0, images = 0, els = doc.GetElementsCount();" +
                    "try { tables = doc.GetAllTables().length; } catch (e) {}" +
                    "try { images = doc.GetAllImages().length; } catch (e) {}" +
                    "return { els: els, tables: tables, images: images };"
                )).then(function (s) { cb(s); }).catch(function (e) { cb({ err: String(e) }); });
            }
            function undoOnce(cb) {
                try {
                    window.Asc.plugin.executeMethod("Undo", [], function (v) { cb({ ok: v }); });
                } catch (e) { cb({ err: String(e) }); }
            }
            readState(function (s0) {
                out.start = s0;
                var i = 0;
                function step() {
                    if (i >= out.max) { resolve(out); return; }
                    i++;
                    undoOnce(function (u) {
                        setTimeout(function () {
                            readState(function (s) {
                                out.steps.push({ undo: u, state: s });
                                step();
                            });
                        }, 300);
                    });
                }
                step();
            });
        });
    }

    function p6read() {
        return cmd(new Function(
            WORD_GUARD +
            "var doc = Api.GetDocument();" +
            "var count = doc.GetElementsCount();" +
            "var els = [];" +
            "for (var i = 0; i < count && i < 100; i++) {" +
            "  var el = doc.GetElement(i);" +
            "  var rec = { i: i };" +
            "  try { rec.classType = el.GetClassType(); } catch (e) {}" +
            "  try { rec.text = String(el.GetText()).slice(0, 80); } catch (e) {}" +
            "  els.push(rec);" +
            "}" +
            "var out = { count: count, els: els };" +
            "try { out.tables = doc.GetAllTables().length; } catch (e) { out.tablesErr = String(e); }" +
            "try { out.images = doc.GetAllImages().length; } catch (e) { out.imagesErr = String(e); }" +
            "return out;"
        ));
    }

    /* ---- P1: insert (one callCommand = one undo step?) ---- */

    function insertText(text) {
        Asc.scope.text = text;
        return cmd(function () {
            var oDocument = Api.GetDocument();
            var oParagraph = Api.CreateParagraph();
            oParagraph.AddText(Asc.scope.text);
            oDocument.InsertContent([oParagraph]);
            return { inserted: true, elements: oDocument.GetElementsCount() };
        });
    }

    /* ---- P4: read ---- */

    function readDoc() {
        return cmd(function () {
            var oDocument = Api.GetDocument();
            var count = oDocument.GetElementsCount();
            var paras = [];
            for (var i = 0; i < count && i < 100; i++) {
                var el = oDocument.GetElement(i);
                var txt = "";
                try { txt = el.GetText(); } catch (e) { txt = "<" + e + ">"; }
                paras.push(String(txt).slice(0, 2000));
            }
            return { paragraphs: count, texts: paras };
        });
    }

    /* ---- P3: selection ---- */

    function selectionSnapshot() {
        return new Promise(function (resolve) {
            var out = {};
            try {
                window.Asc.plugin.executeMethod("GetSelectionType", [], function (t) {
                    out.selectionType = t;
                    finish();
                });
            } catch (e) { out.selectionTypeErr = String(e); finish(); }
            try {
                window.Asc.plugin.executeMethod("GetSelectedText", [], function (t) {
                    out.selectedText = typeof t === "string" ? t.slice(0, 1000) : t;
                    finish();
                });
            } catch (e) { out.selectedTextErr = String(e); finish(); }
            var pending = 2, done = false;
            function finish() {
                if (!--pending && !done) { done = true; resolve(out); }
            }
        });
    }

    var pollTimer = null, lastSel = null;
    function togglePoll() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
            ui("poll stopped");
            report("poll", { enabled: false });
            return;
        }
        pollTimer = setInterval(function () {
            selectionSnapshot().then(function (s) {
                var key = JSON.stringify(s);
                if (key !== lastSel) {
                    lastSel = key;
                    report("selection-change", s);
                    ui("sel change: " + key.slice(0, 120));
                }
            });
        }, 2000);
        ui("poll started (2s)");
        report("poll", { enabled: true });
    }

    function tryAttachEvent() {
        // Does the plugin API expose a selection-change event at all?
        var names = ["onSelectionChange", "onChangeContent", "onCursorMove"];
        var found = [];
        for (var i = 0; i < names.length; i++) {
            try {
                window.Asc.plugin.attachEvent(names[i], function () {
                    report("event-fired", { name: names[i] });
                    ui("EVENT: " + names[i], "ok");
                });
                found.push(names[i]);
            } catch (e) {
                // attachEvent throws for unknown event names
            }
        }
        report("attach-event", { attached: found, tried: names });
        ui("attached: " + (found.join(", ") || "none"));
    }

    /* ---- callCommand helper: probes callback signature ----
     * Docs mention callCommand(func, isNoUndo, isCalcOnly, callback).
     * We try the 4-arg form first; if the callback never fires we fall
     * back to the 3-arg form and report which one worked (first time).
     */
    var signatureReported = false;
    function cmd(fn) {
        return new Promise(function (resolve, reject) {
            var settled = false;
            function reportSig(sig) {
                if (signatureReported) return;
                signatureReported = true;
                report("callcommand-signature", { workingForm: sig });
            }
            function ok(v) { if (!settled) { settled = true; reportSig("4-arg"); resolve(v); } }
            function fail(e) { if (!settled) { settled = true; reject(e); } }
            var t = setTimeout(function () {
                if (settled) return;
                // 4-arg callback never fired; retry with 3-arg form.
                try {
                    window.Asc.plugin.callCommand(fn, false, function (v) {
                        reportSig("3-arg");
                        if (!settled) { settled = true; resolve(v); }
                    });
                } catch (e) {
                    reportSig("3-arg");
                    fail(e);
                }
            }, 4000);
            try {
                window.Asc.plugin.callCommand(fn, false, false, function (v) {
                    clearTimeout(t);
                    ok(v);
                });
            } catch (e) {
                clearTimeout(t);
                fail(e);
            }
        });
    }

    /* ---- wiring ---- */

    window.Asc.plugin.init = function () {
        report("init", { href: location.href, ua: navigator.userAgent });
        ping();
        pollOnce();
    };

    window.Asc.plugin.button = function (id) {
        report("button", { id: id });
    };

    window.Asc.plugin.onExternalPluginMessage = function (data) {
        report("external-message", { data: data });
    };

    document.addEventListener("DOMContentLoaded", function () {
        function bind(id, fn) {
            var el = document.getElementById(id);
            if (el) el.addEventListener("click", fn);
        }
        bind("b-ping", ping);
        bind("b-insert", function () { insertText("Button insert.\n"); });
        bind("b-read", function () { readDoc().then(function (r) { ui("read: " + JSON.stringify(r).slice(0, 200)); }); });
        bind("b-selection", function () { selectionSnapshot().then(function (s) { ui("sel: " + JSON.stringify(s).slice(0, 200)); }); });
        bind("b-attach", tryAttachEvent);
        bind("b-poll", togglePoll);
    });
})(window);
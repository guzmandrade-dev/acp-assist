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
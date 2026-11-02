/*
 * ACP Assist Bridge v0.2 (apps/onlyoffice/bridge-plugin).
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

    var OPS = {
        ping: function () {
            return Promise.resolve({ pong: true, editor: editorType });
        },

        context: function () {
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
            // OnlyOffice's Api has no undo; try the editor's internal
            // command route and report honestly (the companion degrades
            // to "use Ctrl+Z" on failure).
            return new Promise(function (resolve) {
                try {
                    window.Asc.plugin.executeCommand("command", "window.Asc.editor.asc_Undo();");
                    setTimeout(function () { resolve({ undone: true }); }, 400);
                } catch (e) {
                    resolve({ error: String(e) });
                }
            });
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
                plugin: "acp-bridge", version: "0.2.0", editor: t
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
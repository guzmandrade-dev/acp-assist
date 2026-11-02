/*
 * ACP Assist Bridge v0 (apps/onlyoffice/bridge-plugin).
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
 * Ops (writer, one callCommand = one undo step each):
 *   ping, context, insert, insertAfter, rewriteSelection,
 *   rewriteAt, deleteAt, journal
 */
(function (window) {
    var COMPANION = "http://127.0.0.1:8792";
    var POLL_MS = 2000;
    var journal = [];
    var editorType = null;
    var lastEventKey = null;

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
        return fetch(COMPANION + path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        }).catch(function (e) {
            status("companion unreachable", "err");
            throw e;
        });
    }

    function esc(s) {
        return String(s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function htmlFor(text) {
        return String(text).split(/\n/)
            .map(function (p) { return "<p>" + esc(p) + "</p>"; })
            .join("");
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

    /* ---- writer ops ---- */

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
            var read = cmd(function () {
                var oDocument = Api.GetDocument();
                var count = oDocument.GetElementsCount();
                var texts = [];
                for (var i = 0; i < count && i < 200; i++) {
                    var t = "";
                    try { t = oDocument.GetElement(i).GetText(); } catch (e) {}
                    texts.push(String(t));
                }
                return { paragraphs: count, texts: texts };
            });
            return Promise.all([read, selectionSnapshot()]).then(function (r) {
                r[0].texts = r[0].texts.map(norm);
                r[0].selection = r[1];
                r[0].editor = editorType;
                return r[0];
            });
        },

        insert: function (args) {
            requireWord();
            Asc.scope.text = args.text || "";
            return cmd(function () {
                var oDocument = Api.GetDocument();
                var oParagraph = Api.CreateParagraph();
                oParagraph.AddText(Asc.scope.text);
                oDocument.InsertContent([oParagraph]);
                return { elements: oDocument.GetElementsCount() };
            }).then(function (r) {
                record("insert", { text: args.text || "" });
                return r;
            });
        },

        insertAfter: function (args) {
            requireWord();
            Asc.scope.args = { index: args.index, text: args.text || "" };
            return cmd(function () {
                var oDocument = Api.GetDocument();
                var count = oDocument.GetElementsCount();
                if (Asc.scope.args.index < 0 || Asc.scope.args.index >= count) {
                    return { error: "index " + Asc.scope.args.index +
                            " out of range (0.." + (count - 1) + ")" };
                }
                var oParagraph = Api.CreateParagraph();
                oParagraph.AddText(Asc.scope.args.text);
                oDocument.AddElement(Asc.scope.args.index + 1, oParagraph);
                return { elements: oDocument.GetElementsCount() };
            }).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("insertAfter", { index: args.index, text: args.text || "" });
                return r;
            });
        },

        rewriteAt: function (args) {
            requireWord();
            Asc.scope.args = { index: args.index, text: args.text || "" };
            return cmd(function () {
                var oDocument = Api.GetDocument();
                var count = oDocument.GetElementsCount();
                if (Asc.scope.args.index < 0 || Asc.scope.args.index >= count) {
                    return { error: "index " + Asc.scope.args.index +
                            " out of range (0.." + (count - 1) + ")" };
                }
                var old = "";
                try { old = oDocument.GetElement(Asc.scope.args.index).GetText(); }
                catch (e) {}
                oDocument.RemoveElement(Asc.scope.args.index);
                var oParagraph = Api.CreateParagraph();
                oParagraph.AddText(Asc.scope.args.text);
                oDocument.AddElement(Asc.scope.args.index, oParagraph);
                return { oldText: String(old), elements: oDocument.GetElementsCount() };
            }).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("rewriteAt", {
                    index: args.index, oldText: norm(r.oldText),
                    text: args.text || ""
                });
                return r;
            });
        },

        deleteAt: function (args) {
            requireWord();
            Asc.scope.args = { index: args.index };
            return cmd(function () {
                var oDocument = Api.GetDocument();
                var count = oDocument.GetElementsCount();
                if (Asc.scope.args.index < 0 || Asc.scope.args.index >= count) {
                    return { error: "index " + Asc.scope.args.index +
                            " out of range (0.." + (count - 1) + ")" };
                }
                var old = "";
                try { old = oDocument.GetElement(Asc.scope.args.index).GetText(); }
                catch (e) {}
                oDocument.RemoveElement(Asc.scope.args.index);
                return { oldText: String(old), elements: oDocument.GetElementsCount() };
            }).then(function (r) {
                if (r.error) throw new Error(r.error);
                record("deleteAt", { index: args.index, oldText: norm(r.oldText) });
                return r;
            });
        },

        rewriteSelection: function (args) {
            // The editor's own paste route: PasteHtml replaces the active
            // selection (same "use the UI's edit route" principle as the
            // LO bridge's dispatch-based edits).
            return new Promise(function (resolve, reject) {
                try {
                    window.Asc.plugin.executeMethod(
                        "PasteHtml", [htmlFor(args.text || "")],
                        function () { resolve({ pasted: true }); }
                    );
                    // PasteHtml gives no failure signal; resolve via callback
                    // when provided, otherwise assume success.
                    setTimeout(function () { resolve({ pasted: true }); }, 1500);
                } catch (e) {
                    reject(new Error("PasteHtml failed: " + e));
                }
            }).then(function (r) {
                record("rewriteSelection", { text: args.text || "" });
                return r;
            });
        },

        journal: function () {
            return Promise.resolve({ entries: journal.slice().reverse() });
        }
    };

    /* ---- long-poll loop ---- */

    function pollOnce() {
        fetch(COMPANION + "/bridge/next?wait=20")
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
                            id: job.id, ok: false, error: String(e)
                        });
                    });
                }
                pollOnce();
            })
            .catch(function (e) {
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

    window.Asc.plugin.init = function () {
        detectEditor().then(function (t) {
            editorType = t;
            status("connected (" + t + ")", "ok");
            return post("/bridge/hello", {
                plugin: "acp-bridge", version: "0.1.0", editor: t
            });
        }).then(function () {
            pollOnce();
            selectionTick();
        }).catch(function () {
            // hello failed (companion down); retry hello until it answers
            status("companion unreachable", "err");
            setTimeout(function () { window.Asc.plugin.init(); }, 3000);
        });
    };

    window.Asc.plugin.button = function () {};
})(window);
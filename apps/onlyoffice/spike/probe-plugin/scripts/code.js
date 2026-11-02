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
            default:           return Promise.reject(new Error("unknown command " + cmd.type));
        }
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
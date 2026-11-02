/*
 * Phase 0 probe companion (apps/onlyoffice/spike).
 * Zero-dependency Node server. CORS-open so the plugin iframe can reach
 * it regardless of origin. Doubles as the P2 transport probe:
 *   GET  /ping            -> { ok: true }
 *   GET  /probe?wait=20   -> long-poll: next queued command ({} on timeout)
 *   POST /report          -> plugin reports probe outcomes (logged)
 *   POST /cmd             -> queue a command for the plugin
 * Run: node server.mjs   (port 8791, spike log next to it)
 */
import http from "node:http";
import { appendFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = 8791;
const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HERE, "probe-server.log");
if (!existsSync(LOG)) writeFileSync(LOG, "");

const queue = [];
const waiters = [];

function cors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, code, obj) {
    cors(res);
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
}

function body(req) {
    return new Promise((resolve) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
            try { resolve(data ? JSON.parse(data) : {}); }
            catch { resolve({ _parseError: true, _raw: data.slice(0, 500) }); }
        });
    });
}

function log(line) {
    const stamped = new Date().toISOString().slice(11, 23) + " " + line;
    console.log(stamped);
    appendFileSync(LOG, stamped + "\n");
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

    if (req.method === "GET" && url.pathname === "/ping") {
        return json(res, 200, { ok: true, at: Date.now() });
    }

    if (req.method === "GET" && url.pathname === "/probe") {
        const wait = Math.min(parseInt(url.searchParams.get("wait") || "20", 10), 30);
        if (queue.length) return json(res, 200, queue.shift());
        let timer = null;
        const deliver = (cmd) => {
            clearTimeout(timer);
            json(res, 200, cmd);
        };
        waiters.push(deliver);
        timer = setTimeout(() => {
            const i = waiters.indexOf(deliver);
            if (i >= 0) waiters.splice(i, 1);
            json(res, 200, {});
        }, wait * 1000);
        return;
    }

    if (req.method === "POST" && url.pathname === "/report") {
        const payload = await body(req);
        log("REPORT " + JSON.stringify(payload));
        return json(res, 200, { received: true });
    }

    if (req.method === "POST" && url.pathname === "/cmd") {
        const cmd = await body(req);
        cmd.id = cmd.id || `${Date.now()}`;
        log("QUEUE  " + JSON.stringify(cmd));
        if (waiters.length) waiters.shift()(cmd);
        else queue.push(cmd);
        return json(res, 200, { queued: true, id: cmd.id });
    }

    cors(res);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
    log(`probe companion listening on http://127.0.0.1:${PORT}`);
    log(`log file: ${LOG}`);
});
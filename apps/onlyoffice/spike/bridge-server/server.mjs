/*
 * Bridge v0 test companion (apps/onlyoffice/spike/bridge-server).
 * Drives the ACP Assist Bridge plugin the same way the real Electron
 * companion will in Phase 2: a long-poll job queue plus result/event
 * collection. Zero dependencies.
 *
 *   POST /drive            queue an op for the plugin -> {id}
 *   POST /bridge/hello     plugin announces itself
 *   GET  /bridge/next      long-poll: next job for the plugin
 *   POST /bridge/result    plugin posts an op result
 *   POST /bridge/event     plugin posts a selection-change event
 *   GET  /state            last hello + counters (probe helper)
 *   GET  /ping             health check
 */
import http from "node:http";
import { appendFileSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = 8792;
const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HERE, "bridge-server.log");
if (!existsSync(LOG)) writeFileSync(LOG, "");

const state = { hello: null, results: 0, events: 0, lastResult: null, lastEvent: null };
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
        return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/state") {
        return json(res, 200, state);
    }

    if (req.method === "GET" && url.pathname === "/bridge/next") {
        const wait = Math.min(parseInt(url.searchParams.get("wait") || "20", 10), 30);
        if (queue.length) return json(res, 200, queue.shift());
        let timer = null;
        const deliver = (job) => {
            clearTimeout(timer);
            json(res, 200, job);
        };
        waiters.push(deliver);
        timer = setTimeout(() => {
            const i = waiters.indexOf(deliver);
            if (i >= 0) waiters.splice(i, 1);
            json(res, 200, {});
        }, wait * 1000);
        return;
    }

    if (req.method === "POST" && url.pathname === "/drive") {
        const job = await body(req);
        job.id = String(job.id || `${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
        log("DRIVE  " + JSON.stringify(job));
        if (waiters.length) waiters.shift()(job);
        else queue.push(job);
        return json(res, 200, { id: job.id, queued: true });
    }

    if (req.method === "POST" && url.pathname === "/bridge/hello") {
        const hello = await body(req);
        state.hello = hello;
        log("HELLO  " + JSON.stringify(hello));
        return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/bridge/result") {
        const result = await body(req);
        state.results += 1;
        state.lastResult = result;
        log("RESULT " + JSON.stringify(result));
        return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/bridge/event") {
        const event = await body(req);
        state.events += 1;
        state.lastEvent = event;
        log("EVENT  " + JSON.stringify(event));
        return json(res, 200, { ok: true });
    }

    cors(res);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
    log(`bridge companion listening on http://127.0.0.1:${PORT}`);
    log(`log file: ${LOG}`);
});
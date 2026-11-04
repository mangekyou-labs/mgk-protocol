"use strict";
const http = require("node:http");

// Tiny health endpoint so the manifest-bound workers can run as Render free
// web services (Render has no free background workers). Reports only tick
// state; never RPC URLs, keypair paths, or other secrets.
function createHealthState(service) {
  return {
    service,
    startedAt: new Date().toISOString(),
    lastCycleAt: null,
    lastStatus: null,
    lastError: null,
  };
}

function markCycle(state, status) {
  state.lastCycleAt = new Date().toISOString();
  state.lastStatus = status ?? null;
  state.lastError = null;
}

function markError(state) {
  state.lastCycleAt = new Date().toISOString();
  state.lastError = "cycle_failed";
}

function startHealthServer(state, port = Number(process.env.PORT || 10000)) {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: state.lastError == null, ...state }));
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
    }
  });
  server.listen(port, "0.0.0.0");
  return server;
}

module.exports = { createHealthState, markCycle, markError, startHealthServer };

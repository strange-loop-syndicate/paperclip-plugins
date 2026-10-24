// One HTTP server that plays both MemOS (/product/*) and the Paperclip
// issue API (/api/issues/:id). `mode` switches failure behaviour at runtime.

import { createServer } from "node:http";

export async function startFakeServer({ issues = {} } = {}) {
  const state = {
    mode: "ok", // ok | slow | error500
    issueMode: "ok", // ok | hang (Paperclip issue lookup never answers)
    delayMs: 0,
    issues: { ...issues },
    store: [], // { userId, cubeId, content, info }
    requests: [], // { path, body, receivedAt, respondedAt }
  };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const entry = { path: req.url, method: req.method, body: raw ? JSON.parse(raw) : null, headers: req.headers, receivedAt: Date.now(), respondedAt: null };
      state.requests.push(entry);
      const send = (status, json) => {
        if (res.destroyed) return;
        entry.respondedAt = Date.now();
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };

      const issueMatch = req.url.match(/^\/api\/issues\/([^/?]+)$/);
      if (issueMatch) {
        if (state.issueMode === "hang") return;
        const issue = state.issues[decodeURIComponent(issueMatch[1])];
        return issue ? send(200, issue) : send(404, { error: "not found" });
      }

      if (state.mode === "slow" || state.delayMs > 0) {
        await new Promise((r) => setTimeout(r, state.mode === "slow" ? Math.max(state.delayMs, 5000) : state.delayMs));
      }
      if (state.mode === "error500") return send(500, { error: "boom" });

      if (req.url === "/product/add") {
        const b = entry.body;
        state.store.push({ userId: b.user_id, cubeId: b.mem_cube_id, content: b.memory_content, info: b.info ?? {} });
        return send(200, { code: 200, message: "ok", data: null });
      }
      if (req.url === "/product/search") {
        const b = entry.body;
        const memories = state.store
          .filter((m) => m.userId === b.user_id && m.cubeId === b.mem_cube_id)
          .slice(0, b.top_k ?? 10)
          .map((m) => ({ memory: m.content, metadata: m.rawMetadata ?? m.info }));
        return send(200, { code: 200, message: "ok", data: { text_mem: [{ cube_id: b.mem_cube_id, memories }] } });
      }
      send(404, { error: "unknown path" });
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    memosRequests: () => state.requests.filter((r) => r.path.startsWith("/product/")),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/** A URL nothing listens on (server started then closed). */
export async function deadUrl() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

/** Seed a memory directly into the fake store, the way the plugin writes it. */
export function seedMemory(state, { companyId, projectId, content, info = {} }) {
  state.store.push({
    userId: `paperclip-${companyId}`,
    cubeId: `paperclip-${companyId}-${projectId}`,
    content,
    info: { companyId, projectId, ...info },
  });
}

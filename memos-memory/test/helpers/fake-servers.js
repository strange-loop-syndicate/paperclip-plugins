// One HTTP server that plays MemOS (/product/*), the Paperclip issue API
// (/api/issues/:id), the plugin's recall-scopes route, and OpenRouter's Jev
// (/systemone) and chat (/chat/completions) endpoints. `mode` switches MemOS
// failure behaviour at runtime; `llm.mode` switches the OpenRouter side.

import { createServer } from "node:http";

export async function startFakeServer({ issues = {} } = {}) {
  const state = {
    mode: "ok", // ok | slow | error500
    issueMode: "ok", // ok | hang (Paperclip issue lookup never answers)
    delayMs: 0,
    issues: { ...issues },
    store: [], // { userId, cubeId, content, info }
    requests: [], // { path, body, receivedAt, respondedAt }
    // projectId -> [{ projectId, projectName }] answered by the recall-scopes route
    sharedScopes: {},
    sharingMode: "ok", // ok | error500
    llm: {
      mode: "ok", // ok | error500 | error401
      chatMode: "ok", // ok | error503 (extractor only)
      // Jev probabilities by question key, or a function of the request body
      answers: { decision: 0.9, lesson: 0.1, outcome: 0.2, fact: 0.1, routine: 0.1 },
      // Extracted memories, or a function of the request body
      memories: [{ type: "decision", text: "Pre-prompt recall runs in a command wrapper, not a plugin hook." }],
      // A raw chat choice `{ content, finish_reason }` (or a function of the
      // request body) that replaces the JSON memories reply; null for none.
      chatReply: null,
    },
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

      const scopesMatch = req.url.match(/^\/api\/plugins\/([^/]+)\/api\/recall-scopes\?projectId=([^&]+)$/);
      if (scopesMatch) {
        if (state.sharingMode === "error500") return send(500, { error: "boom" });
        return send(200, { scopes: state.sharedScopes[decodeURIComponent(scopesMatch[2])] ?? [] });
      }

      if (req.url === "/systemone" || req.url === "/chat/completions") {
        if (state.llm.mode === "error500") return send(500, { error: "boom" });
        if (state.llm.mode === "error401") return send(401, { error: "bad key" });
        const b = entry.body;
        if (req.url === "/systemone") {
          const probs = typeof state.llm.answers === "function" ? state.llm.answers(b) : state.llm.answers;
          const answers = Object.fromEntries(Object.entries(probs).map(([k, p]) => [k, { noul: p }]));
          return send(200, { model: b.model, answers, usage: { input_tokens: 100, cost: 0.0001 } });
        }
        if (state.llm.chatMode === "error503") return send(503, { error: "overloaded" });
        const raw = typeof state.llm.chatReply === "function" ? state.llm.chatReply(b) : state.llm.chatReply;
        if (raw) return send(200, { choices: [{ finish_reason: raw.finish_reason ?? "stop", message: { role: "assistant", content: raw.content } }], usage: { cost: 0.0002 } });
        const memories = typeof state.llm.memories === "function" ? state.llm.memories(b) : state.llm.memories;
        return send(200, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ memories }) } }], usage: { cost: 0.0002 } });
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
    llmRequests: (path) => state.requests.filter((r) => r.path === path),
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

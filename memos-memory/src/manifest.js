const manifest = {
  id: "sls.memos-memory",
  apiVersion: 1,
  version: "0.2.0",
  displayName: "MemOS Memory",
  description:
    "Turns agent and board comments into short memories (decisions, lessons, outcomes, facts) in a self-hosted MemOS server, scoped per company and project. Jev decides what is worth keeping; an LLM writes it short. Gives agents memory_recall / memory_retain tools.",
  author: "Strange Loop Syndicate",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "agent.tools.register",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issue.comments.read",
    "projects.read",
    "secrets.read-ref",
    "jobs.schedule",
    "api.routes.register",
    "instance.settings.register",
  ],
  entrypoints: { worker: "./src/worker.js", ui: "./ui" },
  instanceConfigSchema: {
    type: "object",
    properties: {
      memosBaseUrl: { type: "string", description: "MemOS API base URL, e.g. http://127.0.0.1:8000" },
      // `format: "secret-ref"` gives the settings form a secret picker. It saves
      // { type: "secret_ref", secretId, version? } and the host binds that secret
      // to this plugin at the field's path; resolve() refuses anything else.
      memosApiKeyRef: { type: "object", format: "secret-ref", title: "MemOS API key", description: "Optional Paperclip secret holding a MemOS bearer token" },
      openrouterApiKeyRef: { type: "object", format: "secret-ref", title: "OpenRouter API key", description: "Paperclip secret holding the OpenRouter key used for Jev and the extractor. Capture is off without it." },
      captureMode: {
        type: "string",
        enum: ["shadow", "save"],
        default: "shadow",
        description: "shadow: log Jev verdicts and extracted memories, save nothing. save: store the extracted memories.",
      },
      saveP: { type: "number", minimum: 0.05, maximum: 1, default: 0.7, description: "Jev probability a content question must reach for an item to pass." },
      routineP: { type: "number", minimum: 0.05, maximum: 1, default: 0.5, description: "An item whose 'routine status only' probability reaches this is skipped." },
      jevModel: { type: "string", default: "typesafe/jev-1.13" },
      extractModel: { type: "string", default: "~anthropic/claude-haiku-latest" },
      openrouterBaseUrl: { type: "string", default: "https://openrouter.ai/api/v1" },
      jevTimeoutMs: { type: "integer", minimum: 500, maximum: 20000, default: 5000 },
      extractTimeoutMs: { type: "integer", minimum: 1000, maximum: 30000, default: 15000 },
      recallTimeoutMs: { type: "integer", minimum: 100, maximum: 10000, default: 3000 },
      captureTimeoutMs: { type: "integer", minimum: 100, maximum: 30000, default: 5000 },
      topK: { type: "integer", minimum: 1, maximum: 50, default: 8 },
      captureComments: { type: "boolean", default: true, description: "Send new agent and board comments to the Jev gate." },
      captureRunOutcomes: { type: "boolean", default: true, description: "Send each finished run's last agent comment to the Jev gate." },
      captureProjectIds: {
        type: "array",
        description: "Optional capture allowlist. If set, memories are captured only for issues in these project IDs. Empty captures every project.",
        default: [],
        items: { type: "string" },
      },
    },
  },
  jobs: [
    {
      jobKey: "retry-pending-captures",
      displayName: "Retry deferred memory captures",
      description: "Retries items that waited because Jev, the extractor or MemOS was down. Items older than 24 h are dropped.",
      schedule: "*/10 * * * *",
    },
  ],
  apiRoutes: [
    { routeKey: "recall-scopes", method: "GET", path: "/recall-scopes", auth: "agent", capability: "api.routes.register" },
    {
      routeKey: "shadow-log",
      method: "GET",
      path: "/shadow-log",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "companySettingsPage",
        id: "memory-sharing",
        displayName: "Memory sharing",
        exportName: "SharingSettingsPage",
        routePath: "memory-sharing",
      },
    ],
  },
  tools: [
    {
      name: "memory_recall",
      displayName: "Recall memory",
      description:
        "Search memories (decisions, engineering lessons, task outcomes, facts) recorded in earlier runs of this project and in projects shared with it. Returns an empty result when the memory service is unavailable.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you want to remember" },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_retain",
      displayName: "Retain memory",
      description:
        "Store one durable memory (a decision, an engineering lesson, a task outcome or a fact) for later runs in this project. One short, self-contained sentence. Duplicates are ignored.",
      parametersSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "One short, self-contained statement" },
          kind: { type: "string", enum: ["decision", "lesson", "outcome", "fact", "note"] },
          issueId: { type: "string", description: "Optional issue this memory is about" },
        },
        required: ["content"],
      },
    },
  ],
};

export default manifest;

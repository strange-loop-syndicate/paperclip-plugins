const manifest = {
  id: "sls.memos-memory",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "MemOS Memory",
  description:
    "Captures agent decisions, engineering lessons and task outcomes into a self-hosted MemOS server, scoped per company and project, and gives agents memory_recall / memory_retain tools.",
  author: "Strange Loop Syndicate",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "agent.tools.register",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issue.comments.read",
    "secrets.read-ref",
  ],
  entrypoints: { worker: "./src/worker.js" },
  instanceConfigSchema: {
    type: "object",
    properties: {
      memosBaseUrl: { type: "string", description: "MemOS API base URL, e.g. http://127.0.0.1:8000" },
      memosApiKeyRef: { type: "string", description: "Optional Paperclip secret reference holding a MemOS bearer token" },
      recallTimeoutMs: { type: "integer", minimum: 100, maximum: 10000, default: 3000 },
      captureTimeoutMs: { type: "integer", minimum: 100, maximum: 30000, default: 5000 },
      topK: { type: "integer", minimum: 1, maximum: 50, default: 8 },
      captureComments: { type: "boolean", default: true },
      captureRunOutcomes: { type: "boolean", default: true },
      captureProjectIds: {
        type: "array",
        description: "Optional capture allowlist. If set, memories are stored only for issues in these project IDs. Empty stores for every project.",
        default: [],
        items: { type: "string" },
      },
      sharedScopes: {
        type: "array",
        description:
          "Opt-in sharing allowlist. Each entry makes one project scope readable by other readers in the SAME company. Empty by default.",
        default: [],
        items: {
          type: "object",
          required: ["companyId", "projectId"],
          properties: {
            companyId: { type: "string" },
            projectId: { type: "string" },
            readerProjectIds: { type: "array", items: { type: "string" } },
            readerAgentIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
  tools: [
    {
      name: "memory_recall",
      displayName: "Recall memory",
      description:
        "Search memories (decisions, engineering lessons, task outcomes) recorded in earlier runs of this project. Returns an empty result when the memory service is unavailable.",
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
        "Store one durable memory (a decision, an engineering lesson, or a task outcome) for later runs in this project. Duplicates are ignored.",
      parametersSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "One self-contained statement" },
          kind: { type: "string", enum: ["decision", "lesson", "outcome", "note"] },
          issueId: { type: "string", description: "Optional issue this memory is about" },
        },
        required: ["content"],
      },
    },
  ],
};

export default manifest;

const manifest = {
  id: "sls.memos-memory",
  apiVersion: 1,
  version: "0.2.1",
  displayName: "MemOS Memory",
  description:
    "Turns agent and board comments into short memories (decisions, lessons, outcomes, facts) in a self-hosted MemOS server, scoped per company and project. A decision model (Jev) decides what is worth keeping; an extract model writes it short. Gives agents memory_recall / memory_retain tools.",
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
  // The host settings form shows the fields in this order, labelled by
  // `title`. It has group headings only inside a collapsed "Advanced options"
  // box (`x-paperclip-advanced`), which would hide the mode, the key and the
  // URLs, so the groups are title prefixes instead. Config keys keep their v1
  // names: the key secret is bound to its config path, and the live config
  // uses these keys.
  instanceConfigSchema: {
    type: "object",
    properties: {
      captureMode: {
        type: "string",
        enum: ["shadow", "save"],
        default: "shadow",
        title: "Capture: mode",
        description:
          "shadow (default): log each keep-or-skip verdict and the memories the extract model writes, store nothing. save: store those memories in MemOS. Turning on save is a board decision.",
      },
      captureProjectIds: {
        type: "array",
        title: "Capture: projects",
        description: "Empty = every project. Add project IDs to capture only those projects. Applies to comments, run outcomes and memory_retain.",
        default: [],
        items: { type: "string", title: "Project ID" },
      },
      captureComments: {
        type: "boolean",
        default: true,
        title: "Capture: comments",
        description: "Send each new agent and board comment to the decision model.",
      },
      captureRunOutcomes: {
        type: "boolean",
        default: true,
        title: "Capture: run outcomes",
        description: "Send each finished run's last agent comment to the decision model.",
      },
      jevModel: {
        type: "string",
        default: "typesafe/jev-1.13",
        title: "Decision: model",
        description: "Decides for each comment and run outcome: keep it or skip it. It gives probabilities only and writes no text. Default: typesafe/jev-1.13 (Jev).",
      },
      saveP: {
        type: "number",
        minimum: 0.05,
        maximum: 1,
        default: 0.7,
        title: "Decision: keep threshold (saveP)",
        description: "Keep an item when the decision model gives a decision, lesson, outcome or durable fact at least this probability. 0.05 to 1, default 0.7.",
      },
      routineP: {
        type: "number",
        minimum: 0.05,
        maximum: 1,
        default: 0.5,
        title: "Decision: routine threshold (routineP)",
        description: "Skip an item when its 'routine status only' probability reaches this, even if it passes the keep threshold. 0.05 to 1, default 0.5.",
      },
      jevTimeoutMs: {
        type: "integer",
        minimum: 500,
        maximum: 20000,
        default: 5000,
        title: "Decision: timeout (ms)",
        description: "Time limit for each try of the decision call. Up to 3 tries. Default 5000.",
      },
      extractModel: {
        type: "string",
        default: "~anthropic/claude-haiku-latest",
        title: "Extraction: model",
        description: "Writes the short memories (at most 3 sentences) from each item the decision model keeps. Default: ~anthropic/claude-haiku-latest.",
      },
      extractTimeoutMs: {
        type: "integer",
        minimum: 1000,
        maximum: 30000,
        default: 15000,
        title: "Extraction: timeout (ms)",
        description: "Time limit for each try of the extract call. Up to 3 tries. Default 15000.",
      },
      openrouterBaseUrl: {
        type: "string",
        default: "https://openrouter.ai/api/v1",
        title: "LLM provider: OpenAI base URL",
        description:
          "Base URL of an OpenAI-compatible API. Default: OpenRouter, https://openrouter.ai/api/v1. The extract model calls <base>/chat/completions. The decision model calls <base>/systemone, which OpenRouter serves.",
      },
      // `format: "secret-ref"` gives the settings form a secret picker. It saves
      // { type: "secret_ref", secretId, version? } and the host binds that secret
      // to this plugin at the field's path; resolve() refuses anything else.
      openrouterApiKeyRef: {
        type: "object",
        format: "secret-ref",
        title: "LLM provider: OpenAI key",
        description:
          "Paperclip secret with the API key for the base URL above. The plugin uses it for two calls: the decision model (keep or skip each comment and run outcome) and the extract model (writes the short memory). Capture is off without it. This key is separate from the keys in memos.env, which MemOS uses for embeddings.",
      },
      memosBaseUrl: {
        type: "string",
        title: "MemOS: base URL",
        description: "Base URL of the self-hosted MemOS API, for example http://127.0.0.1:8001. Empty = the plugin captures and recalls nothing. MemOS needs no key.",
      },
      captureTimeoutMs: {
        type: "integer",
        minimum: 100,
        maximum: 30000,
        default: 5000,
        title: "MemOS: capture timeout (ms)",
        description: "Time limit for each memory write to MemOS. Default 5000.",
      },
      topK: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 8,
        title: "Recall: max memories (topK)",
        description: "Most memories that memory_recall returns. Default 8.",
      },
      recallTimeoutMs: {
        type: "integer",
        minimum: 100,
        maximum: 10000,
        default: 3000,
        title: "Recall: timeout (ms)",
        description: "Time limit for one memory_recall call, across all the projects it reads. Default 3000.",
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

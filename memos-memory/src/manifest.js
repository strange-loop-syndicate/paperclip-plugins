const manifest = {
  id: "sls.memos-memory",
  apiVersion: 1,
  version: "0.3.1",
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
    "issue.comments.create",
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
      dupSimilarity: {
        type: "number",
        minimum: 0.5,
        maximum: 1,
        default: 0.85,
        title: "Decision: duplicate threshold",
        description:
          "Before a memory is stored, MemOS is searched for it. If the best hit is at least this similar (0.5 to 1, a cosine), the memory is a duplicate and is not stored. Default 0.85.",
      },
      dupJudgeFloor: {
        type: "number",
        minimum: 0,
        maximum: 1,
        default: 0.7,
        title: "Decision: duplicate judge floor",
        description:
          "A search hit below the duplicate threshold but at least this similar goes to the duplicate judge, one short call to the extract model: same fact or not. 0 turns the judge off. Default 0.7.",
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
      protectTerms: {
        type: "array",
        title: "Extraction: protected words",
        description:
          "Words the extract model must keep as written, for example a user name the provider would replace with [PERSON_NAME]. Paths, URLs and IP addresses are always kept.",
        default: [],
        items: { type: "string", title: "Word" },
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
      eventHealthIssue: {
        type: "string",
        default: "SLS-120",
        title: "Alerts: deaf plugin issue",
        description:
          "Issue (identifier or ID) that gets one comment when the plugin stops getting events while comments still come in. Empty: log the error only.",
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
    {
      jobKey: "event-health",
      displayName: "Check that events still arrive",
      description:
        "Every minute: if comments came in but no event reached the plugin for 10 minutes, logs an error and posts one comment on the alert issue. A board user must then disable and enable the plugin.",
      schedule: "* * * * *",
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
    {
      routeKey: "dry-run",
      method: "POST",
      path: "/dry-run",
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

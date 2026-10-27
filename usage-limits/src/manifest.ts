import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "lab.usage-limits",
  apiVersion: 1,
  version: "0.5.0",
  displayName: "Usage Limits",
  description:
    "Shows Claude and Codex subscription usage windows (% used, reset time) in the sidebar for the providers this company's agents use.",
  author: "Right2Hope lab",
  categories: ["ui"],
  // http.outbound: the worker calls the Anthropic OAuth usage API itself (Node fetch, so the token stays in the worker).
  capabilities: ["agents.read", "http.outbound", "ui.sidebar.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui/",
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "usage-limits-sidebar",
        displayName: "Usage limits",
        exportName: "UsageLimitsSidebar",
      },
    ],
  },
};

export default manifest;

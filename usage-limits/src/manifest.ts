import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "lab.usage-limits",
  apiVersion: 1,
  version: "0.3.0",
  displayName: "Usage Limits",
  description:
    "Shows Claude and Codex subscription usage windows (% used, reset time) in the sidebar for the providers this company's agents use.",
  author: "Right2Hope lab",
  categories: ["ui"],
  capabilities: ["agents.read", "ui.sidebar.register"],
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

import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-bang-commands",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Bang Commands",
  description: "Run allowlisted shell commands from !name task comments",
  author: "SLS",
  categories: ["automation"],
  capabilities: ["events.subscribe", "issue.comments.read", "issue.comments.create"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;

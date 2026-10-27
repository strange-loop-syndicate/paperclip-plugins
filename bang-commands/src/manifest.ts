import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-bang-commands",
  apiVersion: 1,
  version: "0.3.0",
  displayName: "Bang Commands",
  description: "Run shell commands from owner !command task comments",
  author: "SLS",
  categories: ["automation"],
  capabilities: ["events.subscribe", "issue.comments.read", "issue.comments.create", "issues.wakeup"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;

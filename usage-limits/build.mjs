import { build } from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });

await Promise.all([
  build(presets.esbuild.manifest),
  build(presets.esbuild.worker),
  build({ ...presets.esbuild.ui, jsx: "automatic" }),
]);

console.log("built dist/manifest.js, dist/worker.js, dist/ui/index.js");

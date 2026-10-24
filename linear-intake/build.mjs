import { build } from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets();

await Promise.all([build(presets.esbuild.manifest), build(presets.esbuild.worker)]);

console.log("built dist/manifest.js, dist/worker.js");

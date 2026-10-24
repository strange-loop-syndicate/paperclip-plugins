import { runWorker } from "@paperclipai/plugin-sdk";
import { createMemoryPlugin } from "./plugin.js";

const plugin = createMemoryPlugin();

export default plugin;
runWorker(plugin, import.meta.url);

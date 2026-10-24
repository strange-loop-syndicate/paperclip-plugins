// Validate dist/manifest.js with the host's own manifest schema.
// Usage: node scripts/validate-manifest.mjs [path/to/@paperclipai/shared]
import path from "node:path";
import { pathToFileURL } from "node:url";

const sharedRoot = path.resolve(
  process.argv[2] ?? "/Users/claude/work/paperclip/app/node_modules/@paperclipai/shared",
);
const { pluginManifestV1Schema } = await import(pathToFileURL(path.join(sharedRoot, "dist/index.js")).href);
const { default: manifest } = await import(pathToFileURL(path.resolve("dist/manifest.js")).href);

const result = pluginManifestV1Schema.safeParse(manifest);
if (!result.success) {
  console.error("manifest INVALID");
  console.error(JSON.stringify(result.error.issues, null, 2));
  process.exit(1);
}
console.log(`manifest valid: ${manifest.id}@${manifest.version} capabilities=${manifest.capabilities.join(",")}`);

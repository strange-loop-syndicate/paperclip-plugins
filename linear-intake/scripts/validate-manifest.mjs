// Validate dist/manifest.js with the host's own manifest schema, then check sample
// configs against its instanceConfigSchema with the host's own config validator.
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

const { validateInstanceConfig } = await import(
  pathToFileURL(path.join(sharedRoot, "../server/dist/services/plugin-config-validator.js")).href
);
const secret = { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000000" };
const samples = {
  "key only": { linearApiKey: secret },
  "old id fields": {
    linearApiKey: secret,
    linearAgentUserId: "389b91a0-1540-453a-b3c8-331850dfae9e",
    fallbackProjectId: "b20bc7f4-62a2-46ea-89fa-048d364a3854",
    projectMap: [{ linearProject: "right2hope", paperclipProjectId: "b34f1c20-264c-4dae-91ba-bc8f56a859c2" }],
  },
};
let failed = false;
for (const [label, config] of Object.entries(samples)) {
  const check = validateInstanceConfig(config, manifest.instanceConfigSchema);
  if (!check.valid) {
    failed = true;
    console.error(`config "${label}" INVALID: ${JSON.stringify(check.errors)}`);
  } else console.log(`config "${label}" valid`);
}
if (failed) process.exit(1);

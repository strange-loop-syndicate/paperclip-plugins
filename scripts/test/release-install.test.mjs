// Tests for scripts/release-install.mjs against a temp git origin and a stub Paperclip API.
// Run: node --test scripts/test/
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "release-install.mjs");
const TOKEN = "board-token-must-not-leak";
const COMPANY = "company-1";
const OLD_PATH = "/old/checkout/fake-plugin";
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

let work;
let clone;
let shas;
let server;
let apiBase;
let stub;

function sh(cwd, cmd, args) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.equal(res.status, 0, `${cmd} ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

function writePlugin(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  const pkg = {
    name: "fake-plugin",
    version,
    type: "module",
    paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
    scripts: { build: "node build.mjs", test: "node -e \"process.exit(0)\"" },
  };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    JSON.stringify({ name: "fake-plugin", version, lockfileVersion: 3, requires: true, packages: { "": { name: "fake-plugin", version } } }, null, 2),
  );
  fs.writeFileSync(path.join(dir, "src.txt"), `committed ${version}\n`);
  fs.writeFileSync(
    path.join(dir, "build.mjs"),
    `import fs from "node:fs";
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/manifest.js", "export default { id: 'test.fake-plugin', version: '${version}' };\\n");
fs.writeFileSync("dist/worker.js", "// worker\\n");
`,
  );
}

function makeWritable(dir) {
  if (!fs.existsSync(dir)) return;
  fs.chmodSync(dir, 0o755);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) makeWritable(full);
    else fs.chmodSync(full, 0o644);
  }
}

async function readManifest(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const mod = await import(`${pathToFileURL(path.join(dir, pkg.paperclipPlugin.manifest)).href}?t=${Date.now()}`);
  return mod.default;
}

function freshStub() {
  return {
    mode: "ok",
    // absent: Paperclip has no row for this key (never installed). An uninstalled row
    // still answers GET, as on the real server (resolvePlugin -> registry.getById).
    absent: false,
    requests: [],
    plugin: { id: "plugin-uuid", pluginKey: "test.fake-plugin", version: "0.9.0", status: "ready", packagePath: OLD_PATH },
    configs: { [COMPANY]: { id: "cfg-1", pluginId: "plugin-uuid", companyId: COMPANY, configJson: { apiKey: { type: "secret_ref", secretId: "s1" } } } },
  };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url, "http://stub");
  stub.requests.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null });
  const p = stub.plugin;
  const m = url.pathname.match(/^\/api\/plugins\/([^/]+)(\/config)?$/);
  if (req.method === "GET" && url.pathname === "/api/companies") return json(res, 200, [{ id: COMPANY }]);
  if (req.method === "POST" && url.pathname === "/api/plugins/install") {
    const { packageName } = JSON.parse(body);
    if (p.status !== "uninstalled") return json(res, 409, { error: `Plugin already installed: ${p.pluginKey}` });
    if (stub.mode === "install-fails" && packageName !== OLD_PATH) return json(res, 400, { error: "bad manifest" });
    const manifest = packageName === OLD_PATH ? { version: "0.9.0" } : await readManifest(packageName);
    stub.absent = false;
    Object.assign(p, { status: "ready", packagePath: packageName, version: stub.mode === "wrong-version" ? "9.9.9" : manifest.version });
    // lifecycle.load sets the row ready, then activateReadyPlugin fails to start the worker.
    if (stub.mode === "activate-fails" && packageName !== OLD_PATH) return json(res, 400, { error: "worker failed to start" });
    if (stub.mode === "drop-config") stub.configs[COMPANY] = null;
    return json(res, 200, p);
  }
  if (m && !stub.absent && (m[1] === p.id || m[1] === p.pluginKey)) {
    if (req.method === "GET" && m[2]) return json(res, 200, stub.configs[url.searchParams.get("companyId")] ?? null);
    if (req.method === "GET") return json(res, 200, p);
    if (req.method === "DELETE") {
      if (p.status === "uninstalled") return json(res, 400, { error: `Plugin ${p.pluginKey} is already uninstalled` });
      p.status = "uninstalled";
      return json(res, 200, p);
    }
  }
  return json(res, 404, { error: "Plugin not found" });
}

function runScript(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args, "--repo", clone, "--releases-root", path.join(work, "releases"), "--api-base", apiBase], {
      env: { ...process.env, PAPERCLIP_BOARD_TOKEN: TOKEN, PAPERCLIP_AUTH_STORE: path.join(work, "no-auth.json"), ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const releaseDir = (sha) => path.join(work, "releases", "fake-plugin", sha);
const mutations = () => stub.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);

before(async () => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "release-install-test-")));
  const origin = path.join(work, "origin.git");
  clone = path.join(work, "clone");
  sh(work, "git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  sh(work, "git", ["clone", "--quiet", origin, clone]);
  sh(clone, "git", ["checkout", "--quiet", "-b", "main"]);
  writePlugin(path.join(clone, "fake-plugin"), "1.0.0");
  writePlugin(path.join(clone, "broken-plugin"), "1.0.0");
  const brokenPkg = path.join(clone, "broken-plugin", "package.json");
  const broken = JSON.parse(fs.readFileSync(brokenPkg, "utf8"));
  broken.scripts.test = "node -e \"process.exit(3)\"";
  fs.writeFileSync(brokenPkg, JSON.stringify(broken, null, 2));
  sh(clone, "git", ["add", "."]);
  sh(clone, "git", ["commit", "--quiet", "-m", "v1"]);
  const v1 = sh(clone, "git", ["rev-parse", "HEAD"]);
  writePlugin(path.join(clone, "fake-plugin"), "1.1.0");
  sh(clone, "git", ["commit", "--quiet", "-am", "v1.1"]);
  const v11 = sh(clone, "git", ["rev-parse", "HEAD"]);
  sh(clone, "git", ["push", "--quiet", "origin", "main"]);
  sh(clone, "git", ["checkout", "--quiet", "-b", "feature"]);
  fs.writeFileSync(path.join(clone, "fake-plugin", "src.txt"), "unmerged\n");
  sh(clone, "git", ["commit", "--quiet", "-am", "unmerged"]);
  const unmerged = sh(clone, "git", ["rev-parse", "HEAD"]);
  sh(clone, "git", ["push", "--quiet", "origin", "feature"]);
  sh(clone, "git", ["checkout", "--quiet", "main"]);
  // An uncommitted edit must never reach a release copy.
  fs.writeFileSync(path.join(clone, "fake-plugin", "src.txt"), "dirty working tree\n");
  shas = { v1, v11, unmerged };

  server = http.createServer((req, res) => handle(req, res).catch((err) => json(res, 500, { error: String(err) })));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  apiBase = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  makeWritable(path.join(work, "releases"));
  fs.rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
  stub = freshStub();
});

test("dry run builds a read-only copy of the committed tree and calls no API", async () => {
  const { code, out } = await runScript(["fake-plugin", "--dry-run"]);
  assert.equal(code, 0, out);
  const dir = releaseDir(shas.v11);
  assert.match(out, /plan \(dry run, no API calls\)/);
  assert.match(out, new RegExp(`"packageName": "${dir}"`));
  assert.equal(stub.requests.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, "src.txt"), "utf8"), "committed 1.1.0\n");
  assert.ok(fs.existsSync(path.join(dir, "dist", "worker.js")), "build ran in the copy");
  const marker = JSON.parse(fs.readFileSync(path.join(dir, ".release.json"), "utf8"));
  assert.deepEqual([marker.sha, marker.manifest.version, marker.readOnly], [shas.v11, "1.1.0", true]);
  assert.deepEqual(marker.steps, ["npm ci --no-audit --no-fund", "npm run build", "npm run test"]);
  assert.equal(fs.statSync(dir).mode & 0o222, 0, "release folder is read-only");
  assert.equal(fs.statSync(path.join(dir, "dist", "worker.js")).mode & 0o222, 0, "files are read-only");
  assert.match(fs.readFileSync(path.join(dir, ".release-build.log"), "utf8"), /\$ npm run build/);
  assert.deepEqual(fs.readdirSync(path.dirname(dir)).filter((n) => n.startsWith(".tmp-")), [], "no temp folder left");
});

test("switch: soft uninstall then install from the release copy, all checks pass", async () => {
  const { code, out } = await runScript(["fake-plugin"]);
  assert.equal(code, 0, out);
  const dir = releaseDir(shas.v11);
  assert.match(out, /release copy: reuse/, "dry-run copy is reused, not rebuilt");
  assert.deepEqual(mutations(), ["DELETE /api/plugins/plugin-uuid", "POST /api/plugins/install"]);
  assert.deepEqual(stub.requests.find((r) => r.method === "POST").body, { packageName: dir, isLocalPath: true });
  assert.ok(stub.requests.every((r) => r.auth === `Bearer ${TOKEN}`), "every call carries the board token");
  assert.ok(!out.includes(TOKEN), "token is never printed");
  assert.match(out, /ok {3}version: 1\.1\.0/);
  assert.match(out, new RegExp(`undo path: ${OLD_PATH}`));
  assert.equal(stub.plugin.packagePath, dir);
});

test("already on this release: checks only, no changes", async () => {
  stub.plugin = { ...stub.plugin, version: "1.1.0", packagePath: releaseDir(shas.v11) };
  const { code, out } = await runScript(["fake-plugin"]);
  assert.equal(code, 0, out);
  assert.match(out, /already installed from this release copy/);
  assert.deepEqual(mutations(), []);
});

test("an older sha on origin/main installs its own manifest version", async () => {
  const { code, out } = await runScript(["fake-plugin", shas.v1.slice(0, 10)]);
  assert.equal(code, 0, out);
  assert.equal(stub.plugin.version, "1.0.0");
  assert.equal(stub.plugin.packagePath, releaseDir(shas.v1));
});

test("refuses a commit that is not on origin/main", async () => {
  const { code, out } = await runScript(["fake-plugin", shas.unmerged]);
  assert.equal(code, 2, out);
  assert.match(out, /not on origin\/main/);
  assert.ok(!fs.existsSync(releaseDir(shas.unmerged)));
  assert.equal(stub.requests.length, 0);
});

test("a failing plugin test stops the build: no release folder, temp folder kept", async () => {
  const { code, out } = await runScript(["broken-plugin"]);
  assert.equal(code, 1, out);
  assert.match(out, /npm run test failed/);
  const root = path.join(work, "releases", "broken-plugin");
  assert.ok(!fs.existsSync(path.join(root, shas.v11)));
  assert.equal(fs.readdirSync(root).filter((n) => n.startsWith(".tmp-")).length, 1);
  assert.equal(stub.requests.length, 0);
});

test("refuses an unknown plugin folder", async () => {
  const { code, out } = await runScript(["no-such-plugin", "--dry-run"]);
  assert.equal(code, 2, out);
  assert.match(out, /no plugin folder no-such-plugin\//);
});

test("config change after install fails the run", async () => {
  stub.mode = "drop-config";
  const { code, out } = await runScript(["fake-plugin"]);
  assert.equal(code, 1, out);
  assert.match(out, new RegExp(`FAIL config ${COMPANY}`));
  assert.match(out, /post-install checks failed/);
});

test("version mismatch after install fails the run", async () => {
  stub.mode = "wrong-version";
  const { code, out } = await runScript(["fake-plugin"]);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL version: expected 1\.1\.0, got 9\.9\.9/);
});

test("failed install rolls back to the previous folder", async () => {
  stub.mode = "install-fails";
  const { code, out } = await runScript(["fake-plugin"]);
  assert.equal(code, 1, out);
  const installs = stub.requests.filter((r) => r.method === "POST").map((r) => r.body.packageName);
  assert.deepEqual(installs, [releaseDir(shas.v11), OLD_PATH]);
  assert.deepEqual(mutations(), ["DELETE /api/plugins/plugin-uuid", "POST /api/plugins/install", "POST /api/plugins/install"]);
  assert.match(out, /rollback: done/);
  assert.deepEqual([stub.plugin.status, stub.plugin.packagePath], ["ready", OLD_PATH]);
});

test("worker fails after the row is set ready: rollback uninstalls again, then restores the old folder", async () => {
  stub.mode = "activate-fails";
  const { code, out } = await runScript(["fake-plugin"]);
  assert.equal(code, 1, out);
  assert.deepEqual(mutations(), [
    "DELETE /api/plugins/plugin-uuid",
    "POST /api/plugins/install",
    "DELETE /api/plugins/plugin-uuid",
    "POST /api/plugins/install",
  ]);
  assert.match(out, /worker failed to start/);
  assert.match(out, /rollback: plugin is 'ready' at .*; DELETE/);
  assert.match(out, /rollback: done/);
  assert.deepEqual([stub.plugin.id, stub.plugin.status, stub.plugin.packagePath], ["plugin-uuid", "ready", OLD_PATH]);
});

test("plugin not ready: refuses before any change", async () => {
  stub.plugin.status = "disabled";
  const { code, out } = await runScript(["fake-plugin"]);
  assert.equal(code, 1, out);
  assert.match(out, /is 'disabled', not 'ready'/);
  assert.deepEqual(mutations(), []);
});

test("unknown plugin key needs --allow-new", async () => {
  Object.assign(stub, { absent: true });
  stub.plugin.status = "uninstalled";
  const refused = await runScript(["fake-plugin"]);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /pass --allow-new/);
  assert.deepEqual(mutations(), []);
  const { code, out } = await runScript(["fake-plugin", "--allow-new"]);
  assert.equal(code, 0, out);
  assert.deepEqual(mutations(), ["POST /api/plugins/install"]);
});

test("token comes from the paperclipai CLI auth store when the env var is unset", async () => {
  const store = path.join(work, "auth.json");
  fs.writeFileSync(store, JSON.stringify({ version: 1, credentials: { [`${apiBase}/`]: { apiBase, token: "store-token", createdAt: "x", updatedAt: "x" } } }));
  stub.plugin = { ...stub.plugin, version: "1.1.0", packagePath: releaseDir(shas.v11) };
  const { code, out } = await runScript(["fake-plugin"], { PAPERCLIP_BOARD_TOKEN: "", PAPERCLIP_AUTH_STORE: store });
  assert.equal(code, 0, out);
  assert.ok(stub.requests.every((r) => r.auth === "Bearer store-token"));
  assert.ok(!out.includes("store-token"));
});

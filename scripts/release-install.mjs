#!/usr/bin/env node
// release-install: install or update one plugin from a fixed, read-only release copy.
// Paperclip hot-reloads a local-path plugin on any write in its folder, and that reload
// drops event subscriptions (upstream #14335). So it must never load from a checkout.
//
// Usage: node scripts/release-install.mjs <plugin> [<sha>] [--dry-run] [--api-base URL]
//          [--releases-root DIR] [--repo DIR] [--allow-new]
// <sha> must be on origin/main (default: its tip). Needs a board credential:
// $PAPERCLIP_BOARD_TOKEN or the paperclipai CLI login. See README.md "Install and update".
// Exit codes: 0 done and all checks pass, 1 build, API or check failure, 2 usage error.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_RELEASES_ROOT = "/Users/claude/work/paperclip-plugins-releases";
const DEFAULT_API_BASE = "http://127.0.0.1:3100";
const MARKER = ".release.json";
const API_TIMEOUT_MS = 180_000;

// Plugins that write into their own package folder at runtime keep a writable copy.
// Checked 2026-10-25: none of the four does (memos-memory keeps its logs in plugin state).
const RUNTIME_WRITES = new Set();

class UsageError extends Error {}
class CheckError extends Error {}

function log(line = "") {
  process.stdout.write(`${line}\n`);
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    allowNew: false,
    apiBase: process.env.PAPERCLIP_API_URL || DEFAULT_API_BASE,
    releasesRoot: DEFAULT_RELEASES_ROOT,
    repo: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--allow-new") opts.allowNew = true;
    else if (arg === "--api-base") opts.apiBase = value();
    else if (arg === "--releases-root") opts.releasesRoot = value();
    else if (arg === "--repo") opts.repo = value();
    else if (arg === "-h" || arg === "--help") throw new UsageError("help");
    else if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2) throw new UsageError("expected <plugin> [<sha>]");
  [opts.plugin, opts.sha] = positional;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(opts.plugin)) throw new UsageError(`bad plugin name: ${opts.plugin}`);
  if (opts.sha !== undefined && !/^[0-9a-f]{7,40}$/.test(opts.sha)) throw new UsageError(`bad sha: ${opts.sha}`);
  opts.apiBase = opts.apiBase.trim().replace(/\/+$/, "");
  opts.releasesRoot = path.resolve(opts.releasesRoot);
  return opts;
}

// ---- processes ----------------------------------------------------------

function run(cmd, args, { cwd, logFd, allowFail = false } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: logFd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", logFd, logFd],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !allowFail) {
    const detail = logFd === undefined ? (res.stderr || res.stdout || "").trim().split("\n").slice(-5).join("\n") : "";
    throw new CheckError(`${cmd} ${args.join(" ")} failed (exit ${res.status})${detail ? `:\n${detail}` : ""}`);
  }
  return res;
}

function git(repo, args, opts) {
  return run("git", ["-C", repo, ...args], opts);
}

// ---- source commit ------------------------------------------------------

function resolveRepo(opts) {
  const start = opts.repo ?? path.dirname(fileURLToPath(import.meta.url));
  return git(start, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

function resolveSource(repo, opts) {
  // Writes only under .git; never touches the working tree.
  git(repo, ["fetch", "--quiet", "origin"]);
  const tip = git(repo, ["rev-parse", "--verify", "origin/main^{commit}"]).stdout.trim();
  let sha = tip;
  if (opts.sha) {
    const res = git(repo, ["rev-parse", "--verify", "--quiet", `${opts.sha}^{commit}`], { allowFail: true });
    if (res.status !== 0) throw new UsageError(`unknown commit: ${opts.sha}`);
    sha = res.stdout.trim();
    const onMain = git(repo, ["merge-base", "--is-ancestor", sha, tip], { allowFail: true });
    if (onMain.status !== 0) throw new UsageError(`commit ${sha} is not on origin/main; only merged commits are released`);
  }
  const pkgRes = git(repo, ["show", `${sha}:${opts.plugin}/package.json`], { allowFail: true });
  if (pkgRes.status !== 0) throw new UsageError(`no plugin folder ${opts.plugin}/ at ${sha}`);
  const pkg = JSON.parse(pkgRes.stdout);
  if (!pkg.paperclipPlugin) throw new UsageError(`${opts.plugin}/package.json at ${sha} has no paperclipPlugin entry`);
  return { sha, tip };
}

// ---- release copy -------------------------------------------------------

function readMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8"));
  } catch {
    return null;
  }
}

function buildSteps(pkg) {
  const scripts = pkg.scripts ?? {};
  if (scripts.check) return [["run", "check"]];
  return ["typecheck", "build", "test"].filter((s) => scripts[s]).map((s) => ["run", s]);
}

function checkEntrypoints(dir, pkg) {
  const entries = pkg.paperclipPlugin;
  for (const key of ["manifest", "worker", "ui"]) {
    if (!entries[key]) continue;
    const target = path.resolve(dir, entries[key]);
    if (!target.startsWith(dir + path.sep) || !fs.existsSync(target)) {
      throw new CheckError(`build did not produce paperclipPlugin.${key} (${entries[key]})`);
    }
  }
}

function readManifest(dir, pkg) {
  const manifestPath = path.resolve(dir, pkg.paperclipPlugin.manifest);
  const code = `const m = await import(${JSON.stringify(pathToFileURL(manifestPath).href)});
const v = m.default ?? m.manifest ?? m;
process.stdout.write(JSON.stringify({ id: v.id, version: v.version }));`;
  const res = run(process.execPath, ["--input-type=module", "-e", code], { cwd: dir });
  const manifest = JSON.parse(res.stdout);
  if (!manifest.id || !manifest.version) throw new CheckError(`manifest at ${manifestPath} has no id or version`);
  return manifest;
}

function makeReadOnly(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) makeReadOnly(full);
    else fs.chmodSync(full, fs.statSync(full).mode & ~0o222);
  }
  fs.chmodSync(dir, fs.statSync(dir).mode & ~0o222);
}

function reuseRelease(dir, plugin, sha) {
  const marker = readMarker(dir);
  if (!marker || marker.plugin !== plugin || marker.sha !== sha || !marker.manifest?.version) {
    throw new CheckError(`${dir} exists but has no valid ${MARKER}. Inspect it by hand; this script never deletes release folders.`);
  }
  return marker;
}

function ensureRelease(repo, opts, sha) {
  const pluginRoot = path.join(opts.releasesRoot, opts.plugin);
  const releaseDir = path.join(pluginRoot, sha);
  if (fs.existsSync(releaseDir)) {
    log(`release copy: reuse ${releaseDir}`);
    return { releaseDir, marker: reuseRelease(releaseDir, opts.plugin, sha), reused: true };
  }

  fs.mkdirSync(pluginRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(pluginRoot, `.tmp-${sha.slice(0, 12)}-`));
  const buildLog = path.join(tmp, ".release-build.log");
  log(`release copy: build ${sha} in ${tmp} (log ${buildLog})`);
  const logFd = fs.openSync(buildLog, "a");
  try {
    // Export the committed tree, never the working tree.
    const tarball = `${tmp}.tar`;
    git(repo, ["archive", "--format=tar", "-o", tarball, `${sha}:${opts.plugin}`]);
    run("tar", ["-xf", tarball, "-C", tmp]);
    fs.rmSync(tarball);

    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf8"));
    const steps = [["ci", "--no-audit", "--no-fund"], ...buildSteps(pkg)];
    for (const step of steps) {
      log(`  npm ${step.join(" ")}`);
      fs.writeSync(logFd, `\n$ npm ${step.join(" ")}\n`);
      try {
        run("npm", step, { cwd: tmp, logFd });
      } catch (err) {
        throw new CheckError(`${err.message}\n  see ${buildLog}`);
      }
    }
    checkEntrypoints(tmp, pkg);
    const manifest = readManifest(tmp, pkg);
    const marker = {
      plugin: opts.plugin,
      sha,
      packageName: pkg.name,
      manifest,
      steps: steps.map((s) => `npm ${s.join(" ")}`),
      readOnly: !RUNTIME_WRITES.has(opts.plugin),
      builtAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tmp, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    // Read-only before the rename, so the final folder never changes after it appears.
    if (marker.readOnly) makeReadOnly(tmp);
    try {
      fs.renameSync(tmp, releaseDir);
    } catch (err) {
      if (err.code !== "EEXIST" && err.code !== "ENOTEMPTY") throw err;
      log(`release copy: another run finished ${releaseDir} first; leaving ${tmp} unused`);
      return { releaseDir, marker: reuseRelease(releaseDir, opts.plugin, sha), reused: true };
    }
    log(`release copy: ready ${releaseDir}`);
    return { releaseDir, marker, reused: false };
  } catch (err) {
    log(`release copy: build failed; ${tmp} is left for inspection`);
    throw err;
  } finally {
    fs.closeSync(logFd);
  }
}

// ---- Paperclip API ------------------------------------------------------

function resolveToken(apiBase) {
  const fromEnv = process.env.PAPERCLIP_BOARD_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "PAPERCLIP_BOARD_TOKEN" };
  const home = process.env.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip");
  const store = process.env.PAPERCLIP_AUTH_STORE?.trim() || path.join(home, "auth.json");
  try {
    const credentials = JSON.parse(fs.readFileSync(store, "utf8")).credentials ?? {};
    for (const [key, value] of Object.entries(credentials)) {
      if (key.trim().replace(/\/+$/, "") === apiBase && typeof value?.token === "string" && value.token.trim()) {
        return { token: value.token.trim(), source: store };
      }
    }
  } catch {
    // No store or unreadable store: fall through.
  }
  return { token: null, source: null };
}

class ApiError extends Error {
  constructor(method, route, status, message) {
    super(`${method} ${route} -> ${status}: ${message}`);
    this.status = status;
  }
}

function apiClient(apiBase, token) {
  return async function api(method, route, body) {
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res;
    try {
      res = await fetch(`${apiBase}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ApiError(method, route, "network", err.message);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 200) };
    }
    if (!res.ok) throw new ApiError(method, route, res.status, data?.error ?? res.statusText);
    return data;
  };
}

function pluginView(p) {
  return p && { id: p.id, pluginKey: p.pluginKey, version: p.version, status: p.status, packagePath: p.packagePath };
}

async function readConfigs(api, pluginId, companyIds) {
  const configs = {};
  for (const companyId of companyIds) {
    const row = await api("GET", `/api/plugins/${pluginId}/config?companyId=${encodeURIComponent(companyId)}`);
    configs[companyId] = row ? { id: row.id, configJson: row.configJson } : null;
  }
  return configs;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function samePath(a, b) {
  if (!a || !b) return false;
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

function writeRecord(dir, name, data) {
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(data, null, 2)}\n`);
}

// /install can fail after lifecycle.load has already set the row to `ready` at the new
// path (the worker then fails to start). /install answers 409 for that row, so uninstall
// it again first. Never throws: the caller rethrows the original install error.
async function rollback(api, before) {
  try {
    let current = null;
    try {
      current = await api("GET", `/api/plugins/${before.id}`);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    if (current && current.status !== "uninstalled") {
      log(`rollback: plugin is '${current.status}' at ${current.packagePath}; DELETE /api/plugins/${before.id} (soft uninstall)`);
      await api("DELETE", `/api/plugins/${before.id}`);
    }
    log(`rollback: POST /api/plugins/install ${before.packagePath}`);
    await api("POST", "/api/plugins/install", { packageName: before.packagePath, isLocalPath: true });
    const restored = await api("GET", `/api/plugins/${before.id}`);
    if (restored.status === "ready" && samePath(restored.packagePath, before.packagePath)) {
      log(`rollback: done; ${restored.pluginKey} is ready at ${restored.packagePath}. Run its event check.`);
    } else {
      log(`rollback failed: plugin is '${restored.status}' at ${restored.packagePath}; fix it by hand`);
    }
  } catch (err) {
    log(`rollback failed: ${err.message}; fix it by hand`);
  }
}

async function install(opts, release) {
  const { releaseDir, marker } = release;
  const installPath = fs.realpathSync(releaseDir);
  const pluginKey = marker.manifest.id;
  const { token, source } = resolveToken(opts.apiBase);
  log(token ? `credential: board token from ${source}` : "credential: none found; sending no Authorization header (works only on a local_trusted instance)");
  const api = apiClient(opts.apiBase, token);

  let before = null;
  try {
    before = await api("GET", `/api/plugins/${encodeURIComponent(pluginKey)}`);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (!before && !opts.allowNew) throw new CheckError(`Paperclip has no plugin ${pluginKey}; pass --allow-new for a first install`);
  if (before && before.status !== "ready") throw new CheckError(`plugin ${pluginKey} is '${before.status}', not 'ready'; fix that first`);

  const companies = await api("GET", "/api/companies");
  const companyIds = (Array.isArray(companies) ? companies : []).map((c) => c.id);
  const configsBefore = before ? await readConfigs(api, before.id, companyIds) : {};

  const recordDir = path.join(opts.releasesRoot, "_installs", opts.plugin, new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(recordDir, { recursive: true });
  writeRecord(recordDir, "before.json", { plugin: pluginView(before), configs: configsBefore, target: installPath, sha: marker.sha });
  log(`before: ${JSON.stringify(pluginView(before))}`);
  log(`records: ${recordDir}`);

  const alreadyThere = before && samePath(before.packagePath, installPath);
  if (alreadyThere) {
    log("install: already installed from this release copy; no API changes");
  } else {
    if (before) {
      // /install answers 409 for a plugin that is not uninstalled. A soft uninstall keeps
      // the row (ID, config, state); /install then reuses it and runs lifecycle.load ->
      // activateReadyPlugin, the same full activation that enable runs.
      log(`install: DELETE /api/plugins/${before.id} (soft uninstall, keeps ID and config)`);
      const removed = await api("DELETE", `/api/plugins/${before.id}`);
      if (removed?.status !== "uninstalled") throw new CheckError(`soft uninstall returned status '${removed?.status}'`);
    }
    log(`install: POST /api/plugins/install ${installPath}`);
    try {
      await api("POST", "/api/plugins/install", { packageName: installPath, isLocalPath: true });
    } catch (err) {
      if (before?.packagePath) {
        log(`install failed: ${err.message}`);
        await rollback(api, before);
      }
      throw err;
    }
  }

  const after = await api("GET", `/api/plugins/${encodeURIComponent(before?.id ?? pluginKey)}`);
  const configsAfter = await readConfigs(api, after.id, companyIds);
  const checks = [
    ["status", "ready", after.status],
    ["version", marker.manifest.version, after.version],
    ["packagePath", installPath, after.packagePath, samePath(after.packagePath, installPath)],
  ];
  if (before) {
    checks.unshift(["id", before.id, after.id], ["pluginKey", before.pluginKey, after.pluginKey]);
    for (const companyId of companyIds) {
      checks.push([`config ${companyId}`, stable(configsBefore[companyId]), stable(configsAfter[companyId])]);
    }
  }
  const results = checks.map(([name, expected, actual, ok]) => ({ name, expected, actual, ok: ok ?? expected === actual }));
  writeRecord(recordDir, "after.json", { plugin: pluginView(after), configs: configsAfter, checks: results });

  log("checks:");
  for (const r of results) log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.ok ? r.actual : `expected ${r.expected}, got ${r.actual}`}`);
  if (before) {
    log(`undo path: ${before.packagePath}`);
    if (!alreadyThere) {
      log(`  undo: DELETE /api/plugins/${before.id}, then POST /api/plugins/install {"packageName": ${JSON.stringify(before.packagePath)}, "isLocalPath": true}`);
      log("  (or, if that is a release folder: run this script with its sha)");
    }
  }
  if (results.some((r) => !r.ok)) throw new CheckError("post-install checks failed");
  log(`done: ${pluginKey} ${after.version} runs from ${installPath}`);
}

// ---- main ---------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = resolveRepo(opts);
  const { sha, tip } = resolveSource(repo, opts);
  log(`plugin: ${opts.plugin}`);
  log(`source: ${sha}${sha === tip ? " (tip of origin/main)" : " (on origin/main)"}`);
  const release = ensureRelease(repo, opts, sha);
  log(`manifest: ${release.marker.manifest.id} ${release.marker.manifest.version}`);
  if (opts.dryRun) {
    log("plan (dry run, no API calls):");
    log(`  1. GET /api/plugins/${release.marker.manifest.id}: record id, version, status, packagePath; GET each company's config`);
    log("  2. DELETE /api/plugins/<id> (soft uninstall, keeps ID and config)");
    log(`  3. POST /api/plugins/install {"packageName": ${JSON.stringify(fs.realpathSync(release.releaseDir))}, "isLocalPath": true}`);
    log(`  4. check: status ready, same id, version ${release.marker.manifest.version}, packagePath = release copy, config unchanged`);
    return;
  }
  await install(opts, release);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    if (err.message !== "help") process.stderr.write(`release-install: ${err.message}\n`);
    process.stderr.write("usage: node scripts/release-install.mjs <plugin> [<sha>] [--dry-run] [--api-base URL] [--releases-root DIR] [--repo DIR] [--allow-new]\n");
    process.exit(err.message === "help" ? 0 : 2);
  }
  process.stderr.write(`release-install: ${err.message}\n`);
  process.exit(1);
});

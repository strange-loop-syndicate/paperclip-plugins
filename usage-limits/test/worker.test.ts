import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin, { createPlugin } from "../src/worker.ts";
import manifest from "../src/manifest.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";

function agent(id: string, companyId: string, adapterType: string, status = "idle") {
  return { id, companyId, name: id, adapterType, status } as never;
}

test("used-providers returns the providers of this company's agents", async () => {
  const harness = createTestHarness({ manifest });
  harness.seed({
    agents: [
      agent("a1", COMPANY, "claude_local"),
      agent("a2", COMPANY, "process"),
      agent("a3", OTHER_COMPANY, "codex_local"),
    ],
  });
  await plugin.definition.setup(harness.ctx);
  const data = await harness.getData<{ providers: unknown[] }>("used-providers", { companyId: COMPANY });
  assert.deepEqual(data, { providers: [{ slug: "anthropic", label: "Claude" }] });
});

test("used-providers returns nothing without a companyId", async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);
  assert.deepEqual(await harness.getData("used-providers", {}), { providers: [] });
});

test("used-providers needs the agents.read capability", async () => {
  const harness = createTestHarness({ manifest, capabilities: ["ui.sidebar.register"] });
  await plugin.definition.setup(harness.ctx);
  await assert.rejects(harness.getData("used-providers", { companyId: COMPANY }));
});

test("claude-usage returns the reading and a reason, never the token", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "usage-limits-worker-"));
  const paths = {
    credentialsFile: path.join(dir, ".credentials.json"),
    usageFile: path.join(dir, "usage-exact.json"),
    lockDir: path.join(dir, "lock.d"),
  };
  const token = "sk-ant-oat01-WORKER-TEST";
  await writeFile(paths.credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 3_600_000 } }));
  const fetchStub = (async (url: string | URL | Request) =>
    String(url).endsWith("/profile")
      ? Response.json({ account: { email: "active@example.com" } })
      : Response.json({ five_hour: { utilization: 3, resets_at: "2099-01-01T00:00:00Z" }, seven_day: { utilization: 16, resets_at: "2099-01-04T00:00:00Z" } })) as typeof fetch;
  const withUsage = createPlugin({ paths, fetch: fetchStub, now: Date.now });
  const harness = createTestHarness({ manifest });
  await withUsage.definition.setup(harness.ctx);
  const data = await harness.getData<Record<string, unknown>>("claude-usage", { companyId: COMPANY });
  assert.equal((data.fiveHour as { utilization: number }).utilization, 3);
  assert.equal((data.sevenDay as { utilization: number }).utilization, 16);
  assert.equal(data.account, "active@example.com");
  assert.equal(data.reason, null);
  assert.doesNotMatch(JSON.stringify(data), new RegExp(token));
});

test("manifest declares http.outbound for the usage API call", () => {
  assert.deepEqual(manifest.capabilities, ["agents.read", "http.outbound", "ui.sidebar.register"]);
});

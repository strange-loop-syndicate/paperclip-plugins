import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../src/worker.ts";
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
  const data = await harness.getData<{ providers: unknown[]; agentIds: unknown }>("used-providers", { companyId: COMPANY });
  assert.deepEqual(data.providers, [{ slug: "anthropic", label: "Claude" }]);
  assert.deepEqual(data.agentIds, { anthropic: ["a1"] });
});

test("used-providers returns nothing without a companyId", async () => {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);
  assert.deepEqual(await harness.getData("used-providers", {}), { providers: [], agentIds: {} });
});

test("used-providers needs the agents.read capability", async () => {
  const harness = createTestHarness({ manifest, capabilities: ["ui.sidebar.register"] });
  await plugin.definition.setup(harness.ctx);
  await assert.rejects(harness.getData("used-providers", { companyId: COMPANY }));
});

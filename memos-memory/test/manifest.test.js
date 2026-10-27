import assert from "node:assert/strict";
import { describe, it } from "node:test";
import manifest from "../src/manifest.js";

const props = manifest.instanceConfigSchema.properties;
const keys = Object.keys(props);

// The host form labels a field without `title` from its key ("Capture Timeout Ms").
const autoLabel = (key) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

const GROUPS = [
  ["Capture", ["captureMode", "captureProjectIds", "captureComments", "captureRunOutcomes"]],
  ["Decision", ["jevModel", "saveP", "routineP", "dupSimilarity", "dupJudgeFloor", "jevTimeoutMs"]],
  ["Extraction", ["extractModel", "extractTimeoutMs", "protectTerms"]],
  ["LLM provider", ["openrouterBaseUrl", "openrouterApiKeyRef"]],
  ["MemOS", ["memosBaseUrl", "captureTimeoutMs"]],
  ["Recall", ["topK", "recallTimeoutMs"]],
  ["Alerts", ["eventHealthIssue"]],
];

describe("settings page: the plugin config form", () => {
  it("lists the fields group by group, in the agreed order", () => {
    assert.deepEqual(keys, GROUPS.flatMap(([, fields]) => fields));
  });

  it("prefixes every title with its group", () => {
    for (const [group, fields] of GROUPS) {
      for (const key of fields) assert.ok(props[key].title.startsWith(`${group}: `), `${key}: ${props[key].title}`);
    }
  });

  it("gives every field a real title and help text", () => {
    for (const key of keys) {
      const { title, description } = props[key];
      assert.equal(typeof title, "string", key);
      assert.notEqual(title, autoLabel(key), key);
      assert.ok(typeof description === "string" && description.length >= 20, `${key} has no help text`);
    }
  });

  it("keeps every field visible: none is in the collapsed advanced box", () => {
    for (const key of keys) assert.equal(props[key]["x-paperclip-advanced"], undefined, key);
  });

  it("names the LLM fields provider-neutral and the Jev model the decision model", () => {
    assert.equal(props.openrouterBaseUrl.title, "LLM provider: OpenAI base URL");
    assert.equal(props.openrouterApiKeyRef.title, "LLM provider: OpenAI key");
    assert.equal(props.jevModel.title, "Decision: model");
    for (const key of keys) assert.doesNotMatch(props[key].title, /OpenRouter|Jev/, key);
    assert.doesNotMatch(JSON.stringify(manifest.instanceConfigSchema), /Jev model|Jev gate/);
  });

  it("says what the key is for and that MemOS has its own keys", () => {
    const tip = props.openrouterApiKeyRef.description;
    assert.match(tip, /decision model \(keep or skip each comment and run outcome\)/);
    assert.match(tip, /extract model \(writes the short memory\)/);
    assert.match(tip, /separate from the keys in memos\.env, which MemOS uses for embeddings/);
  });

  it("says an empty project list captures every project", () => {
    assert.match(props.captureProjectIds.description, /^Empty = every project\./);
    assert.deepEqual(props.captureProjectIds.default, []);
  });

  it("still has every key a v1 config saved, except the dropped MemOS key; adds the alert issue and the SLS-200 fields", () => {
    const v1 = [
      "memosBaseUrl", "memosApiKeyRef", "openrouterApiKeyRef", "captureMode", "saveP", "routineP", "jevModel", "extractModel",
      "openrouterBaseUrl", "jevTimeoutMs", "extractTimeoutMs", "recallTimeoutMs", "captureTimeoutMs", "topK",
      "captureComments", "captureRunOutcomes", "captureProjectIds",
    ];
    assert.deepEqual(v1.filter((k) => !(k in props)), ["memosApiKeyRef"]);
    assert.deepEqual(keys.filter((k) => !v1.includes(k)).sort(), ["dupJudgeFloor", "dupSimilarity", "eventHealthIssue", "protectTerms"]);
  });
});

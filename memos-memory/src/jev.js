// The Jev gate: one System One call per item. Jev answers fixed yes/no
// questions with probabilities; `decideGate` turns them into pass/skip in code.
// Jev never writes memory text. Ported from the Upwork `jev_client.py` design.

import { LlmUnavailable, postJsonWithRetries, usageCost } from "./llm-http.js";

export const JEV_URL = "https://openrouter.ai/api/v1/systemone";
// Pinned, not `jev-latest`: an alias moves under tuned thresholds without a change here.
export const JEV_MODEL = "typesafe/jev-1.13";
export const JEV_TIMEOUT_MS = 5000;
export const DEFAULT_SAVE_P = 0.7;
export const DEFAULT_ROUTINE_P = 0.5;

const noul = (instructions, yes, no) => ({ type: "noul", instructions, criteria: { true: yes, false: no } });

/** Content questions, keyed by the memory type they stand for. */
export const CONTENT_QUESTIONS = {
  decision: noul(
    "Does the text record a decision that was made: what was chosen, by the board, an agent or the team?",
    "A choice is stated as made, such as an approach, a tool, a rule, a scope or a yes/no on a proposal",
    "No choice is stated as made; only options, questions, plans or requests",
  ),
  lesson: noul(
    "Does the text state an engineering lesson: a root cause found, a pitfall, or a rule to follow next time?",
    "A cause, a trap or a reusable rule is stated",
    "No cause, trap or reusable rule is stated",
  ),
  outcome: noul(
    "Does the text report how a task or step ended: what was delivered, merged, fixed, measured, or found not possible?",
    "A concrete result is reported",
    "No result is reported; the work is still in progress or only planned",
  ),
  fact: noul(
    "Does the text state a durable fact that stays true after this task: about a system, a tool, a setting, a person's preference or a project?",
    "A lasting fact is stated, such as where something lives, how a system behaves, or what someone prefers",
    "Only facts about this moment, such as what is running now or what happens next",
  ),
};

export const ROUTINE_QUESTION = {
  routine: noul(
    "Is the text only routine status, with nothing worth remembering later?",
    "Only progress pings, hand-offs, 'starting now', 'tests pass', review requests or acknowledgements",
    "It also holds a decision, a lesson, a result or a lasting fact",
  ),
};

export function questions() {
  return { ...CONTENT_QUESTIONS, ...ROUTINE_QUESTION };
}

export const MEMORY_TYPES = Object.keys(CONTENT_QUESTIONS);

function probability(answer) {
  const p = Number(answer?.noul);
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new TypeError("answer has no noul probability");
  return p;
}

/** Probabilities per question; throws TypeError on a missing or malformed answer. */
export function signals(answers) {
  const out = {};
  for (const key of Object.keys(questions())) out[key] = probability(answers?.[key]);
  return out;
}

/**
 * Pass when any content question reaches `saveP` and "routine" stays below
 * `routineP`. The type is the highest content question.
 * Returns { pass, type, probs }.
 */
export function decideGate(answers, { saveP = DEFAULT_SAVE_P, routineP = DEFAULT_ROUTINE_P } = {}) {
  const probs = signals(answers);
  let type = MEMORY_TYPES[0];
  for (const t of MEMORY_TYPES) if (probs[t] > probs[type]) type = t;
  const pass = probs[type] >= saveP && probs.routine < routineP;
  return { pass, type, probs };
}

export function createJevClient({ apiKey, fetchImpl = globalThis.fetch, model = JEV_MODEL, url = JEV_URL, timeoutMs = JEV_TIMEOUT_MS, sleep, now }) {
  return {
    model,
    async ask(state, { deadline } = {}) {
      if (!apiKey) throw new LlmUnavailable("Jev has no API key");
      const started = Date.now();
      const json = await postJsonWithRetries({ fetchImpl, url, apiKey, timeoutMs, sleep, now, deadline, label: "Jev", body: { state, model, questions: questions() } });
      if (!json || typeof json.answers !== "object" || json.answers === null || Array.isArray(json.answers)) {
        throw new LlmUnavailable("Jev answered without an answers object", { outage: false });
      }
      return { answers: json.answers, model: String(json.model ?? model), latencyMs: Date.now() - started, costUsd: usageCost(json) };
    },
  };
}

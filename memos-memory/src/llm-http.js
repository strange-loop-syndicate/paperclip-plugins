// One retrying JSON POST for the OpenRouter calls (Jev and the extractor).
// Every failure becomes one LlmUnavailable, so callers have one thing to
// queue on. The API key never appears in an error or a log line.

export const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 5000;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);
// Refusals that mean every request will fail, not just this one.
const OUTAGE = new Set([401, 402, 403]);

export class LlmUnavailable extends Error {
  /** `outage` is true when the service itself is unusable, false when only this request failed. */
  constructor(message, { outage = true } = {}) {
    super(message);
    this.name = "LlmUnavailable";
    this.outage = outage;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryWait(res, attempt) {
  const asked = Number.parseFloat(res?.headers?.get?.("retry-after") ?? "");
  const ms = Number.isFinite(asked) ? asked * 1000 : 1000 * 2 ** (attempt - 1);
  return Math.max(0, Math.min(ms, MAX_RETRY_WAIT_MS));
}

/**
 * POST `body` as JSON, up to MAX_ATTEMPTS tries, each under `timeoutMs`.
 * `deadline` (epoch ms) stops retries that would end after it.
 * Returns the parsed JSON body; throws LlmUnavailable on any failure.
 */
export async function postJsonWithRetries({ fetchImpl, url, apiKey, body, timeoutMs, label, sleep = defaultSleep, deadline = Infinity, now = Date.now }) {
  let last = "no attempt made";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const left = deadline - now();
    if (left <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, left));
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 200) {
        try {
          return await res.json();
        } catch {
          throw new LlmUnavailable(`${label} answered with a body that is not JSON`, { outage: false });
        }
      }
    } catch (err) {
      if (err instanceof LlmUnavailable) throw err;
      last = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : err?.name ?? "network error";
      res = null;
    } finally {
      clearTimeout(timer);
    }
    if (res) {
      last = `HTTP ${res.status}`;
      if (!RETRYABLE.has(res.status)) throw new LlmUnavailable(`${label} refused the request (${last})`, { outage: OUTAGE.has(res.status) });
    }
    if (attempt < MAX_ATTEMPTS) await sleep(res ? retryWait(res, attempt) : Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS));
  }
  throw new LlmUnavailable(`${label} gave no answer after ${MAX_ATTEMPTS} attempts (${last})`);
}

/** OpenRouter reports `usage.cost` in USD when asked; null when absent. */
export function usageCost(json) {
  const cost = json?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
}

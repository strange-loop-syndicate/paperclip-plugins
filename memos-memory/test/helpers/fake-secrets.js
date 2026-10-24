// A stand-in for the host's `secrets.resolve` in Paperclip 2026.1012.0
// (server/dist/services/plugin-secrets-handler.js). The SDK test harness
// resolves any string, which hid that the real host refuses them. Like the
// host, this one refuses string refs, needs a companyId and a binding row for
// the company, secret, version and configPath, and allows 30 resolves a minute.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RATE_LIMIT = 30;

export const secretRef = (secretId, version) => ({ type: "secret_ref", secretId, ...(version === undefined ? {} : { version }) });

/**
 * @param {object} opts
 * @param {Array<{ companyId: string, secretId: string, configPath: string, version?: string | number }>} opts.bindings
 * @param {Record<string, string>} opts.values secretId -> value
 */
export function fakeHostSecrets({ bindings = [], values = {}, now = () => Date.now() } = {}) {
  const calls = [];
  const attempts = new Map();
  return {
    calls,
    bindings,
    values,
    async resolve(ref, options = {}) {
      calls.push({ ref, options });
      if (typeof ref === "string") {
        throw new Error(`Invalid secret reference for plugin: ${ref.trim() || "<empty>"}. Use { type: "secret_ref", secretId, version? }`);
      }
      if (!ref || typeof ref !== "object" || ref.type !== "secret_ref" || typeof ref.secretId !== "string" || !UUID_RE.test(ref.secretId)) {
        throw new Error(`Invalid secret reference for plugin: ${JSON.stringify(ref)}. Use { type: "secret_ref", secretId, version? }`);
      }
      const companyId = typeof options.companyId === "string" ? options.companyId.trim() : "";
      if (!companyId) throw new Error("companyId is required for plugin secret resolution");
      const t = now();
      const recent = (attempts.get(companyId) ?? []).filter((ts) => ts > t - 60_000);
      if (recent.length >= RATE_LIMIT) throw new Error("Rate limit exceeded for secret resolution");
      recent.push(t);
      attempts.set(companyId, recent);
      const version = String(ref.version ?? "latest");
      const rows = bindings.filter(
        (b) => b.companyId === companyId && b.secretId === ref.secretId && String(b.version ?? "latest") === version && (!options.configPath || b.configPath === options.configPath),
      );
      if (rows.length === 0) throw new Error(`Secret is not bound to plugin${options.configPath ? ` at ${options.configPath}` : ""}`);
      if (rows.length > 1) throw new Error("Plugin secret reference is ambiguous; pass configPath when resolving this secret");
      return values[ref.secretId];
    },
  };
}

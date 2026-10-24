// Stand-in for the host-provided "@paperclipai/plugin-sdk/ui" during the static preview.
export function useHostContext() {
  return { companyId: null };
}
export function usePluginData() {
  return { data: null, loading: false, error: null, refresh() {} };
}
export function useHostNavigation() {
  return { resolveHref: (to) => to, navigate() {}, linkProps: (to) => ({ href: to, onClick() {} }) };
}

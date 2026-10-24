// Company settings page: memory sharing. Plain ESM with React.createElement,
// so the plugin keeps no build step; the host maps "react" and the SDK UI
// import to its own runtime.
//
// One row per project: "readers of project X" is a multi-select of the
// company's other projects, or "All projects". An empty selection shares
// nothing. This page is the only place sharing is set.

import React from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";

const h = React.createElement;
const ALL = "all";

function initialReaders(shares) {
  const out = {};
  for (const s of shares ?? []) out[s.projectId] = s.readers === ALL ? [ALL] : [...s.readers];
  return out;
}

export function SharingSettingsPage({ context }) {
  const companyId = context?.companyId;
  const { data, loading, error, refresh } = usePluginData("sharing-settings", { companyId });
  const save = usePluginAction("save-sharing");
  const [readers, setReaders] = React.useState(null);
  const [status, setStatus] = React.useState(null);

  React.useEffect(() => {
    if (data) setReaders(initialReaders(data.shares));
  }, [data]);

  if (loading || (data && !readers)) return h("p", null, "Loading memory sharing…");
  if (error) return h("p", { role: "alert" }, `Could not load memory sharing: ${error.message}`);
  const projects = data?.projects ?? [];

  const onChange = (projectId) => (event) => {
    let picked = Array.from(event.target.selectedOptions, (o) => o.value);
    if (picked.includes(ALL)) picked = [ALL];
    setReaders({ ...readers, [projectId]: picked });
    setStatus(null);
  };

  const onSave = async () => {
    const shares = Object.entries(readers)
      .filter(([, list]) => list.length > 0)
      .map(([projectId, list]) => ({ projectId, readers: list.includes(ALL) ? ALL : list }));
    setStatus({ kind: "busy", text: "Saving…" });
    try {
      await save({ companyId, shares });
      setStatus({ kind: "ok", text: "Saved. New runs use these settings." });
      refresh();
    } catch (err) {
      setStatus({ kind: "error", text: err?.message ?? "Save failed." });
    }
  };

  const row = (p) =>
    h(
      "tr",
      { key: p.id },
      h("td", { style: { padding: "6px 12px 6px 0", verticalAlign: "top" } }, p.name),
      h(
        "td",
        { style: { padding: "6px 0" } },
        h(
          "select",
          {
            multiple: true,
            "aria-label": `Readers of project ${p.name}`,
            value: readers[p.id] ?? [],
            onChange: onChange(p.id),
            size: Math.min(6, projects.length + 1),
            style: { minWidth: 260 },
          },
          h("option", { value: ALL }, "All projects"),
          ...projects.filter((o) => o.id !== p.id).map((o) => h("option", { key: o.id, value: o.id }, o.name)),
        ),
      ),
    );

  return h(
    "div",
    { style: { display: "grid", gap: 12, maxWidth: 720 } },
    h("h2", { style: { margin: 0 } }, "Memory sharing"),
    h(
      "p",
      { style: { margin: 0 } },
      "Each project reads its own memories. To let other projects read a project's memories, pick them as its readers. Leave a row empty to keep that project private. Ctrl- or Cmd-click picks several.",
    ),
    projects.length === 0
      ? h("p", null, "This company has no projects.")
      : h(
          "table",
          { style: { borderCollapse: "collapse" } },
          h("thead", null, h("tr", null, h("th", { align: "left" }, "Project"), h("th", { align: "left" }, "Readers of this project"))),
          h("tbody", null, ...projects.map(row)),
        ),
    h(
      "div",
      { style: { display: "flex", gap: 12, alignItems: "center" } },
      h("button", { type: "button", onClick: onSave, disabled: status?.kind === "busy" }, "Save sharing"),
      status ? h("span", { role: status.kind === "error" ? "alert" : "status" }, status.text) : null,
    ),
  );
}

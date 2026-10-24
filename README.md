# paperclip-plugins

Strange Loop Syndicate plugins for Paperclip. One folder per plugin.

| Folder | Plugin |
|---|---|
| [`memos-memory/`](memos-memory/) | Memory backed by self-hosted MemOS, plus the pre-prompt recall wrapper for `claude_local` and `codex_local` |
| [`usage-limits/`](usage-limits/) | Claude and Codex subscription usage limits in the sidebar |
| [`bang-commands/`](bang-commands/) | Runs `!<command>` task comments from allowed users and replies with the output |
| [`linear-intake/`](linear-intake/) | Turns Linear issues delegated to the agent user into `[KEY] …` tasks for the Project Lead |

- **Rules:** [`AGENTS.md`](AGENTS.md), then the plugin folder's own `AGENTS.md`.

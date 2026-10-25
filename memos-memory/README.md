# memos-memory

Paperclip memory plugin backed by self-hosted MemOS, plus a pre-prompt recall wrapper for the `claude_local` and `codex_local` adapters. A decision model (Jev) decides what is worth keeping; an extract model writes it as short memories.

- **Setup:** [`SETUP.md`](SETUP.md)
- **Tests:** `npm install && npm test`

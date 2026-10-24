# linear-cli

`linear`: a small Node CLI for agents to read and update Linear over its GraphQL API. It replaces the Paperclip Linear MCP in plugin-started runs, where the MCP fails with `user_authorization_required` (SLS-132, SLS-135).

## Use
```
LINEAR_API_KEY=… node bin/linear.mjs <command> [args]
```

| Command | Does |
|---|---|
| `whoami` | The key's user and organization |
| `get-issue <KEY>` | One issue |
| `list-comments <KEY>` | All comments, every page, oldest first, with `parentId` and `resolvedAt` |
| `set-state <KEY> <state name>` | Move to the team's state with that name, then read back |
| `comment <KEY> --body-file F [--parent <id>]` | Post a comment or threaded reply, then read back |
| `resolve-comment <commentId>` | Resolve a thread, then read back |

- **Output:** pretty JSON on stdout; errors as `linear: …` on stderr.
- **Exit codes:** 0 ok, 1 Linear or network error, 2 usage error (nothing written), 3 write sent but readback does not match.
- **Key:** env `LINEAR_API_KEY` only. Personal keys (`lin_api_…`) go in the `Authorization` header as-is; any other value is sent as `Bearer <token>`. The key is scrubbed from error text.
- **Not included:** delete, archive, issue creation.

## Develop
```
npm run check
```
No dependencies, so no install step. Tests mock `fetch`; they never reach Linear.

## Skill
[`skill/SKILL.md`](skill/SKILL.md) is the company skill `linear-api`. Agents read it, not this README.

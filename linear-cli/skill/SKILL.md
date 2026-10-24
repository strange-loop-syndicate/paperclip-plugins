---
name: linear-api
description: Read and update Linear issues from a Paperclip run with the `linear` CLI over Linear's GraphQL API, without the Paperclip Linear MCP. Use when a task needs a Linear issue, its comments, a state change, a comment or threaded log reply, or resolving a comment thread.
---

# Linear over the GraphQL API

## Key
- **Source:** env `LINEAR_API_KEY` only. The Project Director binds it to your agent's environment as a Paperclip secret.
- **Never** print it, echo it, pass it on the command line, or read `.env` files to find it. The CLI reads no files for the key.
- **Missing key:** the CLI exits 2 with `LINEAR_API_KEY is not set`. Do not look for another key. Set the task `blocked` and ask its creator to bind one.
- **Identity:** every write appears in Linear as the key's user. Run `whoami` once to see who that is.

## Run
```
node /Users/claude/work/paperclip-plugins-repo/linear-cli/bin/linear.mjs <command> [args]
```
Output is JSON on stdout. Run it as a standalone command and read the JSON directly. Pipes are refused in Paperclip runs.

## Commands
| Command | Does |
|---|---|
| `whoami` | The key's user and organization |
| `get-issue <KEY>` | One issue: title, description, state, team, assignee, delegate, project, labels |
| `list-comments <KEY>` | Every comment on every page, oldest first, with `parentId` and `resolvedAt` |
| `set-state <KEY> <state name>` | Moves the issue to its team's state with that name (case-insensitive), then reads it back |
| `comment <KEY> --body-file F [--parent <commentId>]` | Posts a comment, or a threaded reply under `--parent`, then reads it back |
| `resolve-comment <commentId>` | Resolves a comment thread, then reads it back |

- **KEY** is the Linear identifier, for example `M-696`. Team key is `M`; `STR-N` ids render as `M-N`.
- **No delete, archive or issue-create commands exist.** Ask your manager if a task needs one.
- **Body file:** write the comment with the Write tool to `.pc-api/linear-<name>.md` in your working folder. Do not commit `.pc-api/`. Files named `.env*`, `*.pem` or `*.key` are refused.

## Exit codes
| Code | Meaning |
|---|---|
| 0 | Done. Stdout holds the object, re-fetched after any write |
| 1 | Linear or network error. The message is on stderr |
| 2 | Usage error: bad arguments, missing key, unknown state name (stderr lists the team's states). Nothing was written |
| 3 | The write was sent, but the readback does not show it. Stdout holds the readback. Reconcile before retrying |

## Verify every write
`linear.md` requires a readback after each write. The CLI does it for you:
- **set-state:** exits 3 unless the re-fetched issue has the new state.
- **comment:** exits 3 if the re-fetched comment is on another issue or has another parent. `bodyMatches: false` means Linear stored a different body. Check that the tail and any closing `+++` fence survived.
- **resolve-comment:** exits 3 unless `resolvedAt` is set.
- **Exit 3 or a timeout:** run `list-comments` or `get-issue` first. Only retry if the write is not there, so you do not post twice.

## Log thread recipe (`linear.md`)
1. `list-comments <KEY>` and find the top-level comment (`parentId: null`) whose body starts with `📋 Session log`.
2. None found: post one with `comment <KEY> --body-file F`. Its `id` is the anchor.
3. Post each log entry with `comment <KEY> --body-file F --parent <anchor id>`.
4. `resolve-comment <anchor id>` after each reply, so the thread renders collapsed.

## Status rules
`linear.md` still applies: In Progress when you start, In Review when you finish, never Done. A status change is never an approval.

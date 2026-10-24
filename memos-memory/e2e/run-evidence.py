"""SLS-63 E2E: evidence for one Paperclip run of a wrapped claude_local or
codex_local agent. Prints the wrapper's [paperclip-memos] stderr line from
the run log, and whether the first prompt the CLI received holds the nonce.

Usage: python3 -I e2e/run-evidence.py <run-log.ndjson> <session-transcript> <nonce>
The transcript is the Claude session .jsonl or the Codex rollout .jsonl.
"""
import json
import re
import sys

run_log, transcript, nonce = sys.argv[1:4]

wrapper_lines = []
for line in open(run_log, encoding="utf-8"):
    rec = json.loads(line)
    for m in re.finditer(r"\[paperclip-memos\][^\n]*", rec.get("chunk", "")):
        wrapper_lines.append({"ts": rec["ts"], "stream": rec["stream"], "line": m.group(0)})


def texts(content):
    if isinstance(content, str):
        return [content]
    out = []
    for part in content or []:
        if isinstance(part, dict):
            out.append(part.get("text") or part.get("input_text") or "")
    return out


first_prompt = None
for line in open(transcript, encoding="utf-8"):
    rec = json.loads(line)
    # Claude session: {"type":"user","message":{"content":...}}
    if rec.get("type") == "user" and isinstance(rec.get("message"), dict):
        joined = "\n".join(texts(rec["message"].get("content")))
        if joined.strip():
            first_prompt = joined
            break
    # Codex rollout: {"type":"response_item","payload":{"type":"message","role":"user","content":[...]}}
    payload = rec.get("payload") if isinstance(rec.get("payload"), dict) else None
    if payload and payload.get("type") == "message" and payload.get("role") == "user":
        joined = "\n".join(texts(payload.get("content")))
        if "Paperclip" in joined:
            first_prompt = joined
            break

block = None
if first_prompt:
    m = re.search(r"<paperclip-memory>.*?</paperclip-memory>", first_prompt, re.S)
    block = m.group(0) if m else None

print(json.dumps({
    "wrapperLines": wrapper_lines,
    "promptFound": first_prompt is not None,
    "promptHead": (first_prompt or "")[:200],
    "memoryBlock": block,
    "nonceInPrompt": bool(first_prompt and nonce in first_prompt),
}, indent=2))

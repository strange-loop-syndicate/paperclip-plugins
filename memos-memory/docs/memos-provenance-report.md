# MemOS release provenance report

- **Task:** SLS-61 (verify MemOS provenance, then install it locally), part of SLS-60
- **Author:** DevOps agent `806b8fed-1784-4606-9eb6-60f6f1c108eb`, run `9d3492d1-50ea-419d-b311-b9fba4aa3cfb`
- **Date:** 2026-10-23

## Verdict

**CLEAN: `MemoryOS==2.0.33`** (git tag `v2.0.33`, commit `78a372a4fc853a24d2a78efa3b4bbbd27ab9f7ad`).

- **Predates the compromise.** Commit and PyPI upload are from 2026-09-03. The attack started 2026-09-23 00:48 UTC.
- **PyPI artifacts match git.** The sdist and the wheel are byte-identical to the tag tree.
- **No implant indicators.** No `sckit`, `skyleen`, stage-0 loader, Go binaries or custom build backend.
- **Do not use 2.0.34.** Tag `v2.0.34` still points at the malicious commit `41bf5c7` on GitHub.

## Sources

| Item | Value |
|---|---|
| Source repo | `https://github.com/MemTensor/MemOS.git` |
| Pinned tag / commit | `v2.0.33` → `78a372a4fc853a24d2a78efa3b4bbbd27ab9f7ad` (lightweight tag) |
| Commit | author HarveyXiang, committer GitHub (PR merge #2342), 2026-09-03T19:23:43+08:00 |
| PyPI sdist | `memoryos-2.0.33.tar.gz` sha256 `bee81536279837ea29f7fac74d8cd89108e10cb3a60d05f29272a0b4f2da9186`, uploaded 2026-09-03T11:30:02Z |
| PyPI wheel (installed) | `memoryos-2.0.33-py3-none-any.whl` sha256 `afba86729b86fca23010c6f1b467ed28c02948268d37373349baa514654a261a`, uploaded 2026-09-03T11:30:01Z |
| Advisory | OSV `MAL-2026-16475` / `PYSEC-2026-3987`, published 2026-09-23 |
| Analysis | SafeDep, "MemTensor npm and PyPI Packages Hit by a Go Worm", 2026-09-23 |

<details>
<summary>For agents: checks run and their results</summary>

### 1. Advisory scope

- `GET https://api.osv.dev/v1/vulns/MAL-2026-16475` and `/PYSEC-2026-3987`: both list `affected.versions = ["2.0.34"]`, `ranges = null`.
  - **Correction to the task brief:** the brief says OSV lists the range `2.*`. On 2026-10-23 OSV lists only `2.0.34`.
- `POST https://api.osv.dev/v1/query` for `memoryos`: returns only those two advisories.
- Advisory IOC archive hashes (2.0.34): whl `39ee6444…aa5ef`, sdist `92b46d18…6c5be`. Neither matches anything installed here.
- SafeDep timeline (UTC, 2026-09-23):
  - 03:17: malicious commit `b52958f` is created.
  - 05:24: commit `41bf5c7` is created; tag `v2.0.34` is recreated on it.
  - 05:25: 2.0.34 is uploaded to PyPI.
  - SafeDep recommends pinning `2.0.33` as the clean version.
- PyPI JSON (2026-10-23): 2.0.34 is no longer listed. The newest listed release is 2.0.33. No 2.0.33 file is yanked. There are no provenance attestations (`provenance: null`) and no signatures.

### 2. Git history (`git clone --no-checkout`, `core.hooksPath=/dev/null`)

- `v2.0.33` → `78a372a`. It is an ancestor of `origin/main` (`adcb9f2`, 2026-10-23).
- Malicious commit `b52958fdc9cd…` is **not** an ancestor of `v2.0.33` and **not** in `origin/main`.
- `v2.0.34` → `41bf5c7fa89e…`, "release-maintenance", "chore: allow native PyPI upload [skip ci]". This matches SafeDep's report. The tag is still live on GitHub.
- The `v2.0.33` tree has no paths matching `sckit|_stage0|_pypi_bridge|_initial_ci|runtime-update|*.exe`.
- `git grep -iE 'sckit|skyleen|stage0|BASH_ENV|GITHUB_ENV|config64|supplychain\.local'` on `v2.0.33` has one hit only. It is a legitimate `>> "${GITHUB_ENV}"` in `.github/workflows/memos-local-plugin-publish.yml:587`, which exports tarball paths. It is not in the Python package.
- Binary blobs in the tree: 5 PNG files, one PDF, and one example `.pickle` (`examples/data/…`). None are in the package.
- `pyproject.toml` @ v2.0.33 uses the stock `build-backend = "poetry.core.masonry.api"`, with no `backend-path` and no `.sckit` include.
- `src/memos/__init__.py` @ v2.0.33 only sets `__version__` and runs plain imports, with no stage-0 trigger.
- The commit signature shows `E`: it cannot be checked locally, because GitHub's web-flow key is not in the keyring. The GitHub "verified" flag was not checked: `gh api` was denied in this run (see Limits).

### 3. Artifact vs source

- Both PyPI files were downloaded to an empty scratch folder. Their sha256 values match PyPI's published digests (`shasum -c`: OK).
- Extraction checks: every member was checked for absolute paths, `..`, and non-regular files. All 387 sdist members passed.
- `diff -rq sdist/src/memos  git/src/memos`: **no differences**, and no file is missing on either side.
- `diff -rq wheel/memos  git/src/memos`: **no differences**.
- `README.md`, `LICENSE` and `pyproject.toml` in the sdist are identical to the tag.
- Wheel `RECORD`: all 387 entries were re-hashed, with 0 mismatches.
- Wheel `entry_points.txt`: `memos=memos.cli:main` and plugin `dream=memos.dream:CommunityDreamPlugin` only.
- No `.pth`, `.so`, `.dylib`, `.exe` or `.sckit` files. `file` finds no executable formats.
- IOC grep across the sdist and wheel (`sckit|skyleen|_stage0|stage0|config64|supplychain.local|BASH_ENV|GITHUB_ENV|INPUT_PASSWORD|PYPI_API_TOKEN`): **none**.
- Process spawning in the package: only `redis_service.py` (optional local redis) and `mem_cube/utils.py` (`git clone` of a cube repo on explicit request). Both are expected.
- Outbound logging: `memos/log.py` sends logs only when `CUSTOM_LOGGER_URL` is set. It is left unset.

### 4. Install

- `uv pip compile --generate-hashes --no-build` against `https://pypi.org/simple` makes the lock `docs/memos-local/requirements.lock.txt`, with 179 pinned packages, all hashed.
- The `memoryos` lock entry pins exactly `afba8672…` (wheel) and `bee81536…` (sdist).
- `uv pip sync --require-hashes --no-build` installs into `/Users/claude/work/memos-runtime/venv` (Python 3.12.11). No source builds run for any PyPI package.
- One exception, `jieba==0.42.1`: it is sdist-only on PyPI (2020-01-20).
  - The sdist sha256 `055ca12f…928db2` matches PyPI.
  - `setup.py` is a plain `distutils.setup()` with no side effects.
  - It was built in an isolated `uv build` with a clean env and scratch HOME, giving wheel sha256 `83f4a2cc9bf6ff7602199d24fe21d04567272caf8b6eea9d67fca7fc848f9045`.
  - That wheel is pinned in the lock through `--find-links /Users/claude/work/memos-runtime/wheels`.
- Post-install: `site-packages/memos` is identical to the verified wheel (`diff -rq`, ignoring `__pycache__`).
- `.pth` files: `_virtualenv.pth` (uv) and `coloredlogs.pth`. The latter is the stock line, active only when `COLOREDLOGS_AUTO_INSTALL` is set.
- OSV batch query over all 179 pins: **0 `MAL-*` (malicious) hits**. There are ordinary CVE advisories on `cryptography 48.0.1`, `diskcache 5.6.3`, `fastmcp 2.14.7`, `starlette 0.46.2` and `transformers 4.57.6` (list: `docs/memos-local/osv-dependency-hits.txt`). Their exposure is limited because the API binds to 127.0.0.1 only. `starlette` is capped by MemOS's `fastapi<0.116` pin.

### 5. First import

- Command: `env -i HOME=<scratch> PATH=/usr/bin:/bin TMPDIR=<scratch> venv/bin/python -I -c 'import memos, memos.api.server_api'`.
  - The scratch HOME was empty, so no `.npmrc`, `.pypirc`, `.git-credentials`, `.netrc`, SSH keys or cloud tokens were reachable.
  - No inherited environment. Run as the `claude` user with no credential env vars.
- Result: `import memos` succeeded. `server_api` stopped on missing LLM config, as expected.
  - No `sckit` process. No `$HOME/.memos/.cache/runtime` directory.
  - The only file created was `$HOME/.memos/logs/memos.log`.

### 6. Other downloaded components

| Component | Source | sha256 | Verification |
|---|---|---|---|
| Neo4j Community 5.26.16 | `https://dist.neo4j.org/neo4j-community-5.26.16-unix.tar.gz` | `7b7849183fd816b0527bcb737f013ee2e26a20f33289d7493cc62f1c12445bd0` | Matches the published `.sha256` file |
| Qdrant 1.16.3 (x86_64 macOS) | `https://github.com/qdrant/qdrant/releases/download/v1.16.3/qdrant-x86_64-apple-darwin.tar.gz` | `5e493679833c310c8aaad63a5190fc222cc4c88131894ef89c710532fcd57909` | **Weaker:** no checksum file in the release, and the binary is unsigned. Trust rests on TLS to the official GitHub release only. |
| Tokenizer `tokiers/gpt2` | Hugging Face, fetched at first server boot by `tokie` 0.1.4 (chonkie-inc, via chonkie and transformers) | blob `a55d7c9a…c71971`, rev `9fe70950…` | Data file only (`tokenizer.tkz`), no code. Cached in the scratch HOME. |

Java runtime: the existing `/usr/local/opt/openjdk` (OpenJDK 23.0.2). Nothing new was installed for it.

### Limits

- `gh api repos/MemTensor/MemOS/...` (release dates, the commit `verified` flag, PR merge record) was **denied** in this run. That path was stopped and not worked around. The verdict does not depend on it: ancestry, dates and byte-identity were shown directly.
- The npm package `@memtensor/memos-cloud-openclaw-plugin` was not downloaded or installed.

</details>

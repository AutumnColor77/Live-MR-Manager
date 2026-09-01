# AI PR Review Ruleset — Live MR Manager

> Used by Qodo/PR-Agent (`.pr_agent.toml`) and CodeRabbit (`.coderabbit.yaml`).
> Not a substitute for human review or `scripts/prebuild-supply-chain.*`.

## Priority 1 — Security defects (always comment)

| ID | Rule | Examples |
| --- | --- | --- |
| SEC-01 | No secrets in source | Discord webhook URLs, OAuth client secrets, API keys, session tokens |
| SEC-02 | IPC input validation | New `#[tauri::command]` params must validate path/URL/token/length |
| SEC-03 | Opener / deep-link abuse | Arbitrary URL open, scheme confusion, token injection, accepting `?token=` in Songbook desktop callback instead of `?code=` + `/api/auth/desktop-exchange` |
| SEC-04 | Path traversal / SSRF | Untrusted paths into `fs`, HTTP clients without host allowlists |
| SEC-05 | Capability regression | Re-adding `opener:default`, `assetProtocol: **` or `$HOME/**`, `csp: null` |
| SEC-06 | Secret logging | Logging full bearer tokens, webhook URLs, `.env` contents |
| SEC-07 | XSS / untrusted HTML | `innerHTML` with YouTube titles, Songbook request fields, or other untrusted strings — use `escapeHtml` / `textContent` |
| SEC-08 | Unsigned floating downloads | Restoring `releases/latest` for yt-dlp, skipping SHA-256 for UVR/yt-dlp, or `--no-check-certificates` |

**Fail-worthy (request changes / Critical):** SEC-01, SEC-05 with world-readable secrets, hardcoded production webhooks.

## Priority 2 — Exception handling gaps

| ID | Rule | Examples |
| --- | --- | --- |
| ERR-01 | No `unwrap`/`expect` on user or network IO in release paths | `fs::read`, `reqwest`, SQLite |
| ERR-02 | Tauri commands must surface `Err` | Do not swallow security-relevant failures |
| ERR-03 | Partial failure cleanup | Downloads must delete temp files on hash/verify failure |
| ERR-04 | Async hygiene | Avoid blocking the runtime with long sync CPU/IO without `spawn_blocking` |

## Priority 3 — Code smells / maintainability

| ID | Rule | Examples |
| --- | --- | --- |
| SMELL-01 | Duplicated validation | Reimplementing URL/path checks instead of `ipc_validate` |
| SMELL-02 | Legacy Meloming reintroduction | Official catalogs or default sync paths for Meloming-only rows |
| SMELL-03 | Dead / commented production hacks | `#\[allow(dead_code)]` hiding unfinished security controls |
| SMELL-04 | License policy drift | Adding CC-BY-NC models to official `MODELS` / `ALIGNMENT_MODELS` |

## Priority 4 — Tests & docs (Medium)

| ID | Rule |
| --- | --- |
| TEST-01 | Pure parsers/validators changed without unit tests |
| TEST-02 | Security workflow or supply-chain scripts changed without checklist note |

## Out of scope (do not comment)

- Import sorting, rustfmt-only diffs, comment typos
- Dependency lockfile churn without code changes
- Stylistic rename-only PRs

## Suggested comment format

```text
[Severity: Critical|High|Medium] [Rule: SEC-02]
What: <one sentence>
Why: <risk>
Fix: <concrete suggestion>
```

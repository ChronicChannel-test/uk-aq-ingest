# CodeQL Remediation Workflow (Option B)

Use this workflow to export open CodeQL alerts, batch them deterministically, and generate Codex-ready work specs.

## Repository CodeQL setup

Advanced setup is defined in:
- `.github/workflows/codeql.yml`
- `.github/codeql/codeql-config.yml`

Current scan scope excludes archive paths:
- `archive/**`

This prevents new alerts from archived code while keeping active code paths in scope.

## 1) Authenticate GitHub API

Set a token with one of the following:
- Classic PAT: `security_events:read` (and `repo` if the repository is private).
- Fine-grained PAT: repository access to the target repo with repository permission `Code scanning alerts: Read`.
- Org permissions are not required for this workflow because it uses repo endpoints (`/repos/{owner}/{repo}/code-scanning/...`).

```bash
export GITHUB_TOKEN="<your_token>"
```

If `GITHUB_TOKEN` and `GH_TOKEN` are both unset, `scripts/codeql_alerts_export.py` falls back to `gh auth token`.

## 2) Export open CodeQL alerts + instances

```bash
python3 scripts/codeql_alerts_export.py \
  --repo ChronicChannel-test/uk-aq-ingest \
  --state open \
  --per-page 100
```

Default output:
- `.codeql/exports/<YYYY-MM-DD>/alerts.json`
- `.codeql/exports/<YYYY-MM-DD>/instances/<alert_number>.json`

## 3) Create deterministic batches

```bash
python3 scripts/codeql_batch.py \
  --alerts .codeql/exports/<YYYY-MM-DD>/alerts.json \
  --instances-dir .codeql/exports/<YYYY-MM-DD>/instances \
  --batch-size 10
```

Default output: `.codeql/batches/<YYYY-MM-DD>/batch-01.json`, etc.

## 4) Generate Codex task spec for batch 01

```bash
python3 scripts/codeql_make_task_specs.py \
  --batches-dir .codeql/batches/<YYYY-MM-DD> \
  --batch batch-01.json
```

Output: `.codeql/task-specs/<YYYY-MM-DD>/batch-01.md`

## 5) Run a separate Codex fix task

Create a new Codex task and paste the generated `batch-01.md` spec as the implementation brief.
That task should remediate only the listed alerts, run checks, and open a PR.

## Troubleshooting

- **401/403 (permissions):** token is invalid or missing required access (`security_events:read` for classic PAT, or `Code scanning alerts: Read` for fine-grained PAT with repo access).
- **Rate limits:** wait for reset, use authenticated requests, or reduce retry pressure.
- **Pagination concerns:** scripts follow GitHub `Link` headers until exhausted.
- **No alerts exported:** check repo, default branch analysis status, and `--state` filter.

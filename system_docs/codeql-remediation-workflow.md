# CodeQL Remediation Workflow (Option B)

Use this workflow to export open CodeQL alerts, batch them deterministically, and generate Codex-ready work specs.

## 1) Authenticate GitHub API

Set a token with `security_events:read` scope (classic PAT) or equivalent fine-grained permission.

```bash
export GITHUB_TOKEN="<your_token>"
```

If `GITHUB_TOKEN` is unset, `scripts/codeql_alerts_export.py` falls back to `gh auth token`.

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

- **401/403 (permissions):** token is missing required security-events access.
- **Rate limits:** wait for reset, use authenticated requests, or reduce retry pressure.
- **Pagination concerns:** scripts follow GitHub `Link` headers until exhausted.
- **No alerts exported:** check repo, default branch analysis status, and `--state` filter.

# Render free-tier deployment helpers

These scripts let OpenClaw run on Render's **free** web service (no persistent
disk) without losing state on every cold start / idle sleep.

OpenClaw is SQLite-only by design (`docs/refactor/database-first.md`), so rather
than forking the storage layer to Postgres, we reuse the built-in
`openclaw backup create` / `openclaw backup verify` commands and shuttle the
resulting tarball to **Supabase Storage** on a timer, restoring the latest copy
before each boot.

## Files

- `supabase-backup.mjs` — talks to the Supabase Storage REST API via `fetch`.
  Subcommands: `backup` (create + upload) and `restore` (download + verify +
  extract). No runtime deps; `node:` built-ins only.
- `entrypoint.sh` — Render `dockerCommand` wrapper: restore → start backup loop
  in the background → `exec node openclaw.mjs gateway`.

## Setup (outside the repo)

1. Supabase dashboard → **Storage → New bucket** → name `openclaw-backups`,
   **private**. The service-role (secret) key bypasses RLS, so the bucket must
   not be public.
2. Set `SUPABASE_SERVICE_KEY` as a Render secret env var (`sync: false` in
   `render.yaml` → Render prompts for it in the dashboard).

## Tradeoffs (inherent to the free tier)

- **RPO ≤ 14 min**: a crash/sleep can lose up to one backup interval.
- **Workspace files are excluded** (`--no-include-workspace`) to keep the
  tarball small and the upload fast. State, config, credentials, and SQLite
  databases are included.
- Free services **sleep after 15 min idle**; the loop only runs while awake, so
  the last awake-window backup is what restores on next boot.

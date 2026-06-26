# Render free-tier deployment helpers

These files let OpenClaw run on Render's **free** web service (no persistent
disk, no shell access) fully configured via env vars — no interactive `openclaw
onboard`/`configure` needed.

OpenClaw is SQLite-only by design (`docs/refactor/database-first.md`), so rather
than forking the storage layer to Postgres, we reuse the built-in
`openclaw backup create` / `backup verify` commands and shuttle the resulting
tarball to **Supabase Storage** on a timer, restoring the latest copy before
each boot.

## Files

- `scripts/render/supabase-backup.mjs` — Supabase Storage REST client. Subcommands
  `backup` (create + upload) and `restore` (download + verify + extract). No
  runtime deps; `node:` builtins + the production `tar` package only.
- `scripts/render/entrypoint.sh` — Render `dockerCommand` wrapper. Boot flow:
  restore → apply seed config → set default model → seed SOUL.md → validate →
  start backup loop → `exec node openclaw.mjs gateway`.
- `render-config/openclaw.seed.json5` — `openclaw.json` **structure + SecretRefs**
  (no secret values). Applied idempotently at boot via `openclaw config patch`.
- `render.yaml` — service definition: free plan, no disk, `dockerCommand`, and
  the env-var block (most secrets marked `sync: false`).

## Boot sequence

```
restore Supabase backup (if any)
  → openclaw config patch --file render-config/openclaw.seed.json5
  → openclaw config set agents.defaults.model {primary: $OPENCLAW_DEFAULT_MODEL}
  → write $OPENCLAW_SOUL_MD → /home/node/.openclaw/workspace/SOUL.md (if missing)
  → openclaw config validate
  → background: backup loop every 840s
  → exec node openclaw.mjs gateway
```

Each step is non-fatal on failure (warns and continues) so a bad secret or
missing bucket can't wedge the gateway — it boots with whatever config is on
disk. Check Render logs for `[render-entrypoint]` lines to diagnose.

## Environment variables

All of these are set in Render's dashboard (your service → **Environment**).
`sync: false` in `render.yaml` means Render marks them as secrets: it prompts
once, then hides the value.

### Required for hosting

| Var | Example | Purpose |
|-----|---------|---------|
| `OPENCLAW_DEFAULT_MODEL` | `anthropic/claude-opus-4-1` | Default model ref (`provider/model`). Switch provider without a rebuild. |
| `OPENAI_API_KEY` | `sk-...` | OpenAI provider key. Set only if using an `openai/*` model. |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Anthropic provider key. Set only if using an `anthropic/*` model. |
| `TELEGRAM_BOT_TOKEN` | `123:abc...` | Telegram bot token from BotFather. |
| `OPENCLAW_SOUL_MD` | *(persona text)* | Written to `workspace/SOUL.md` on first boot. See `docs/concepts/soul.md`. |

### Supabase (state persistence)

| Var | Example | Purpose |
|-----|---------|---------|
| `SUPABASE_URL` | `https://<ref>.supabase.co` | Project URL (set as a value in render.yaml). |
| `SUPABASE_SERVICE_KEY` | `sb_secret_...` | **Secret** key (bypasses RLS; bucket must stay private). |
| `SUPABASE_BACKUP_BUCKET` | `openclaw-backups` | Bucket name (set as a value in render.yaml). |
| `OPENCLAW_BACKUP_INTERVAL_SECONDS` | `840` | Backup cadence (default 840 = 14 min). |

### Gateway (set as values in render.yaml)

| Var | Value | Purpose |
|-----|-------|---------|
| `OPENCLAW_GATEWAY_PORT` | `8080` | Port Render's proxy targets. |
| `OPENCLAW_GATEWAY_BIND` | `lan` | Bind `0.0.0.0` so Render's proxy can reach the gateway (default is loopback). |

## Setup (outside the repo)

1. **Supabase bucket**: dashboard → Storage → New bucket → name
   `openclaw-backups`, **private**. The service-role key bypasses RLS, so the
   bucket must not be public.
2. **Telegram bot**: talk to `@BotFather`, `/newbot`, copy the token. After you
   paste it into Render, **revoke it** (`/revoke`) if you ever shared it.
3. **First deploy on Render**: when prompted, paste the secret env vars above.
4. **Telegram DMs** use pairing policy: message your bot, then approve:
   `openclaw pairing list telegram` / `openclaw pairing approve telegram <CODE>`
   (pairing codes expire after 1 hour). On free tier without shell, approve via
   the Control UI at your service URL once the gateway is up.

## How secrets stay out of the repo

`render-config/openclaw.seed.json5` contains only **SecretRef objects** that point
at env vars, e.g.:

```json5
botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" }
```

OpenClaw resolves these into an in-memory snapshot at activation and never writes
the resolved values into `openclaw.json` or `agents/*/agent/models.json`
(docs/gateway/secrets.md). The seed file is therefore safe to commit; only the
env var **values** (in Render's dashboard) are secret.

## Tradeoffs (inherent to the free tier)

- **RPO ≤ 14 min**: a crash/sleep can lose up to one backup interval.
- **Workspace files excluded** from the backup (`--no-include-workspace`):
  state, config, credentials, and SQLite DBs are backed up; agent workspace
  scratch is not. `SOUL.md` is re-seeded from env on every boot, so it survives.
- Free services **sleep after 15 min idle**; the loop only runs while awake.
- Secret key bypasses RLS; the bucket must stay private.
- This is a **deployment wrapper**, not OpenClaw-shipped behavior. No changes to
  `src/`, `packages/`, plugins, or runtime behavior.

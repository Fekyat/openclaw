#!/usr/bin/env sh
# Render free-tier entrypoint: restore latest backup, run a periodic backup loop,
# then start the OpenClaw gateway as PID 1 via the image's tini entrypoint.
#
# Wired in render.yaml via `dockerCommand`. The Dockerfile ENTRYPOINT (tini -s)
# stays in place, so this script runs under tini and signal handling is correct.
#
# Env (see supabase-backup.mjs for the full list):
#   SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_BACKUP_BUCKET
#   OPENCLAW_BACKUP_INTERVAL_SECONDS (default 840 = 14 min)
set -eu

WORKDIR="${OPENCLAW_RENDER_WORKDIR:-/app}"
cd "$WORKDIR"

# Skip the Supabase loop entirely when the secret key is absent (e.g. local
# docker runs) so the image still boots a plain gateway.
if [ -z "${SUPABASE_SERVICE_KEY:-}" ] || [ -z "${SUPABASE_URL:-}" ]; then
  echo "[render-entrypoint] SUPABASE_URL/SUPABASE_SERVICE_KEY not set; skipping backup/restore."
  exec node openclaw.mjs gateway
fi

# Seed the agent persona (SOUL.md) into the workspace before boot.
# OpenClaw reads workspace files at runtime, so placing SOUL.md here gives every
# session the persona. `ensureAgentWorkspace` uses writeFileIfMissing, so an
# existing SOUL.md is preserved and the default template won't overwrite it.
# OPENCLAW_SOUL_MD is a Render secret env var; never inline persona text here.
if [ -n "${OPENCLAW_SOUL_MD:-}" ]; then
  WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/home/node/.openclaw/workspace}"
  mkdir -p "$WORKSPACE_DIR"
  SOUL_PATH="$WORKSPACE_DIR/SOUL.md"
  if [ ! -f "$SOUL_PATH" ]; then
    printf '%s\n' "$OPENCLAW_SOUL_MD" > "$SOUL_PATH"
    echo "[render-entrypoint] Seeded SOUL.md into $WORKSPACE_DIR."
  else
    echo "[render-entrypoint] SOUL.md already present; keeping existing."
  fi
fi

# Restore before boot so the gateway sees the latest persisted state. A missing
# remote backup (first boot) is not an error; the script exits 0 in that case.
echo "[render-entrypoint] Restoring latest backup from Supabase (if any)..."
node scripts/render/supabase-backup.mjs restore || {
  echo "[render-entrypoint] WARNING: restore failed; continuing with empty state." >&2
}

# Periodic backup loop in the background. Render free services sleep after 15 min
# idle, so this only runs while the gateway is awake; the last awake-window
# backup is what the next cold start restores.
INTERVAL="${OPENCLAW_BACKUP_INTERVAL_SECONDS:-840}"
echo "[render-entrypoint] Starting backup loop (interval ${INTERVAL}s) in background..."
(
  # Sleep first: we just restored, so the next backup happens after one interval.
  while true; do
    sleep "$INTERVAL" || exit 0
    node scripts/render/supabase-backup.mjs backup || \
      echo "[render-entrypoint] WARNING: scheduled backup failed." >&2
  done
) &
BACKUP_PID=$!

# Forward signals to the gateway so Render's stop/redeploy shuts it down cleanly.
trap 'kill "$BACKUP_PID" 2>/dev/null || true' INT TERM

# Run the gateway in the foreground. `exec` replaces this shell so the gateway
# becomes the process Render tracks for health checks and restarts.
echo "[render-entrypoint] Starting OpenClaw gateway..."
exec node openclaw.mjs gateway

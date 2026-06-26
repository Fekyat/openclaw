#!/usr/bin/env sh
# Render free-tier entrypoint:
#   1. Restore latest Supabase backup (if any)
#   2. Apply seed config (structure + SecretRefs) via `openclaw config patch`
#   3. Set default model + provider from env
#   4. Seed SOUL.md persona from env
#   5. Start a periodic backup loop in the background
#   6. exec the OpenClaw gateway as PID 1 (under the image's tini entrypoint)
#
# Wired in render.yaml via `dockerCommand`. The Dockerfile ENTRYPOINT (tini -s)
# stays in place, so this script runs under tini with correct signal handling.
#
# All secrets are Render env vars consumed via SecretRefs; nothing secret is
# written into the image or openclaw.json. See scripts/render/README.md.
set -eu

WORKDIR="${OPENCLAW_RENDER_WORKDIR:-/app}"
SEED_CONFIG="${OPENCLAW_SEED_CONFIG:-/app/render-config/openclaw.seed.json5}"
cd "$WORKDIR"

# Skip the Supabase loop entirely when the secret key is absent (e.g. local
# docker runs) so the image still boots a plain gateway.
SUPERBASE_ENABLED=1
if [ -z "${SUPABASE_SERVICE_KEY:-}" ] || [ -z "${SUPABASE_URL:-}" ]; then
  echo "[render-entrypoint] SUPABASE_URL/SUPABASE_SERVICE_KEY not set; skipping backup/restore."
  SUPERBASE_ENABLED=0
fi

if [ "$SUPERBASE_ENABLED" -eq 1 ]; then
  # Restore before boot so the gateway sees the latest persisted state. A missing
  # remote backup (first boot) is not an error; the script exits 0 in that case.
  echo "[render-entrypoint] Restoring latest backup from Supabase (if any)..."
  node scripts/render/supabase-backup.mjs restore || {
    echo "[render-entrypoint] WARNING: restore failed; continuing with empty state." >&2
  }
fi

# Apply seed config (structure + SecretRefs). `config patch` merges recursively;
# re-running on a restored config is a safe no-op. Non-fatal: a bad seed shouldn't
# prevent the gateway from booting with whatever config is already on disk.
if [ -f "$SEED_CONFIG" ]; then
  echo "[render-entrypoint] Applying seed config: $SEED_CONFIG"
  openclaw config patch --file "$SEED_CONFIG" || {
    echo "[render-entrypoint] WARNING: seed config patch failed; continuing with existing config." >&2
  }
else
  echo "[render-entrypoint] No seed config at $SEED_CONFIG; skipping."
fi

# Default model + provider, switched via env without a rebuild.
# Accepts a model ref like "anthropic/claude-opus-4-1" or "openai/gpt-5.5".
if [ -n "${OPENCLAW_DEFAULT_MODEL:-}" ]; then
  echo "[render-entrypoint] Setting default model: $OPENCLAW_DEFAULT_MODEL"
  openclaw config set agents.defaults.model "{\"primary\":\"$OPENCLAW_DEFAULT_MODEL\"}" \
    --strict-json || {
    echo "[render-entrypoint] WARNING: could not set default model." >&2
  }
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

# Validate the final config before boot so the gateway doesn't fail late.
echo "[render-entrypoint] Validating config..."
openclaw config validate || {
  echo "[render-entrypoint] WARNING: config validation failed; gateway may error on boot." >&2
}

if [ "$SUPERBASE_ENABLED" -eq 1 ]; then
  # Periodic backup loop in the background. Render free services sleep after
  # 15 min idle, so this only runs while the gateway is awake; the last
  # awake-window backup is what the next cold start restores.
  INTERVAL="${OPENCLAW_BACKUP_INTERVAL_SECONDS:-840}"
  echo "[render-entrypoint] Starting backup loop (interval ${INTERVAL}s) in background..."
  (
    while true; do
      sleep "$INTERVAL" || exit 0
      node scripts/render/supabase-backup.mjs backup || \
        echo "[render-entrypoint] WARNING: scheduled backup failed." >&2
    done
  ) &
  BACKUP_PID=$!
  trap 'kill "$BACKUP_PID" 2>/dev/null || true' INT TERM
fi

# Run the gateway in the foreground. `exec` replaces this shell so the gateway
# becomes the process Render tracks for health checks and restarts.
echo "[render-entrypoint] Starting OpenClaw gateway..."
exec node openclaw.mjs gateway

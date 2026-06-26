// Render free-tier persistence helper: shuttle OpenClaw SQLite state to/from
// Supabase Storage so it survives Render's ephemeral filesystem + idle sleeps.
//
// OpenClaw is SQLite-only by design (docs/refactor/database-first.md), so this
// reuses the built-in `openclaw backup create` / `openclaw backup verify`
// commands instead of forking the storage layer. No runtime deps; node: builtins
// + fetch + the production `tar` package only.
//
// Env:
//   SUPABASE_URL            e.g. https://<ref>.supabase.co        (required)
//   SUPABASE_SERVICE_KEY    secret/service_role key (bypasses RLS)  (required)
//   SUPABASE_BACKUP_BUCKET  storage bucket name (default openclaw-backups)
//   OPENCLAW_BIN            openclaw binary path (default "openclaw")
//   OPENCLAW_BACKUP_OBJECT  object key (default openclaw-backup.tar.gz)
//
// Usage:
//   node scripts/render/supabase-backup.mjs backup
//   node scripts/render/supabase-backup.mjs restore

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

const BACKUP_OBJECT = process.env.OPENCLAW_BACKUP_OBJECT ?? "openclaw-backup.tar.gz";

function log(msg) {
  process.stdout.write(`[supabase-backup] ${msg}\n`);
}

function fail(msg, err) {
  process.stderr.write(`[supabase-backup] ERROR: ${msg}\n`);
  if (err) {
    process.stderr.write(`${err?.stack ?? String(err)}\n`);
  }
  process.exit(1);
}

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`Missing required env var: ${name}`);
  }
  return value;
}

function getConfig() {
  return {
    url: readRequiredEnv("SUPABASE_URL").replace(/\/+$/u, ""),
    key: readRequiredEnv("SUPABASE_SERVICE_KEY"),
    bucket: process.env.SUPABASE_BACKUP_BUCKET?.trim() || "openclaw-backups",
  };
}

function storageHeaders(config, extra = {}) {
  // The secret key authorizes as the service role and bypasses RLS; the bucket
  // must stay private. Both headers are required by the Storage API gateway.
  return {
    authorization: `Bearer ${config.key}`,
    apikey: config.key,
    ...extra,
  };
}

function storageObjectUrl(config, query) {
  const base = `${config.url}/storage/v1/object/${config.bucket}/${BACKUP_OBJECT}`;
  return query ? `${base}?${query}` : base;
}

/** Run the openclaw CLI, returning trimmed stdout. Throws on non-zero exit. */
function runOpenClaw(args) {
  const bin = process.env.OPENCLAW_BIN?.trim() || "openclaw";
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      if (code !== 0) {
        reject(new Error(`openclaw ${args.join(" ")} exited ${code}\n${stderr}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr });
    });
  });
}

/** Create a backup archive via `openclaw backup create`, return its path. */
async function createBackupArchive() {
  const archivePath = path.join(os.tmpdir(), `openclaw-backup-${randomUUID()}.tar.gz`);
  // --no-include-workspace keeps the tarball small (state + config + creds +
  // SQLite DBs only); workspace scratch is not worth the upload cost on free tier.
  const { stdout } = await runOpenClaw([
    "backup",
    "create",
    "--output",
    archivePath,
    "--no-include-workspace",
    "--json",
  ]);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Non-JSON output means the create failed despite exit 0; surface it.
    fail("backup create did not emit JSON", new Error(stdout.slice(0, 500)));
  }
  if (!parsed?.archivePath) {
    fail("backup create result missing archivePath");
  }
  return parsed.archivePath;
}

async function uploadToSupabase(config, archivePath) {
  const stat = await fs.stat(archivePath);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
  log(`Uploading ${archivePath} (${sizeMB} MB) to ${config.bucket}/${BACKUP_OBJECT}`);

  // Streaming upload keeps memory bounded regardless of tarball size. The
  // upsert=true query lets successive backups overwrite the single object key.
  const stream = createReadStream(archivePath);
  const response = await fetch(storageObjectUrl(config, "upsert=true"), {
    method: "POST",
    headers: storageHeaders(config, {
      "content-type": "application/octet-stream",
      "content-length": String(stat.size),
    }),
    body: stream,
    // Node 22+ allows a web Readable stream body; duplex is required for it.
    duplex: "half",
  });

  if (!response.ok) {
    const body = await response.text();
    fail(`Supabase upload failed: HTTP ${response.status} ${response.statusText}\n${body}`);
  }
  log(`Upload complete: HTTP ${response.status}`);
}

/** Download the remote backup to a local path. Returns false if none exists. */
async function downloadFromSupabase(config, destPath) {
  log(`Downloading ${config.bucket}/${BACKUP_OBJECT} to ${destPath}`);
  const response = await fetch(storageObjectUrl(config), {
    headers: storageHeaders(config),
  });
  // First boot: no backup yet. Treat 404 (and the Storage API's 400-for-not-found
  // envelope) as "nothing to restore" rather than a hard failure.
  if (response.status === 404 || response.status === 400) {
    log(`No remote backup found (HTTP ${response.status}); skipping restore.`);
    return false;
  }
  if (!response.ok) {
    const body = await response.text();
    fail(`Supabase download failed: HTTP ${response.status} ${response.statusText}\n${body}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destPath, buffer);
  log(`Download complete: ${buffer.length} bytes`);
  return true;
}

async function verifyArchive(archivePath) {
  try {
    await runOpenClaw(["backup", "verify", archivePath]);
    log("Archive verification passed.");
  } catch (err) {
    fail("Archive verification failed; refusing to restore a corrupt backup.", err);
  }
}

// The backup tarball encodes each source path under
// `<archiveRoot>/payload/<posix|windows|relative>/<encoded-source-path>` (see
// src/commands/backup-shared.ts encodeAbsolutePathForBackupArchive). On a Linux
// container every source path is absolute, so they land under `payload/posix/`.
// We extract the whole tarball to a temp dir, then copy the `posix/` subtree back
// to its original absolute path (prepending the leading `/`).
async function extractPayloadToRoot(tempDir, archivePath) {
  const tar = await import("tar");
  await tar.x({ file: archivePath, cwd: tempDir, gzip: true });

  // Find `<archiveRoot>/payload/posix` regardless of the timestamped root name.
  let posixRoot = await findPayloadPosixRoot(tempDir);
  if (!posixRoot) {
    fail(
      "Backup archive has no payload/posix directory; refusing to restore (unexpected archive layout).",
    );
  }
  log(`Restoring payload from ${path.relative(tempDir, posixRoot)}`);

  await copyTreeToRoot(posixRoot);
}

async function findPayloadPosixRoot(tempDir) {
  const entries = await fs.readdir(tempDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const payloadDir = path.join(tempDir, entry.name, "payload");
    try {
      await fs.access(payloadDir);
    } catch {
      continue;
    }
    const posixDir = path.join(payloadDir, "posix");
    try {
      await fs.access(posixDir);
      return posixDir;
    } catch {
      continue;
    }
  }
  return undefined;
}

// Recursively copy every file under payloadRoot into its absolute target,
// restoring the `/`-prefixed path that encodeAbsolutePathForBackupArchive stripped.
async function copyTreeToRoot(payloadRoot) {
  let copied = 0;
  async function visit(relDir) {
    const srcDir = path.join(payloadRoot, relDir);
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = path.posix.join(relDir, entry.name);
      if (entry.isDirectory()) {
        await visit(relPath);
        continue;
      }
      if (!entry.isFile()) {
        // Symlinks/hardlinks inside the payload are not expected for SQLite
        // snapshots or state files; skip defensively rather than dereferencing.
        continue;
      }
      const destPath = path.posix.join("/", relPath);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      const srcPath = path.join(srcDir, entry.name);
      await fs.copyFile(srcPath, destPath);
      copied += 1;
    }
  }
  await visit("");
  log(`Restored ${copied} file${copied === 1 ? "" : "s"} to absolute paths.`);
}

async function backupCommand() {
  const config = getConfig();
  const archivePath = await createBackupArchive();
  try {
    await uploadToSupabase(config, archivePath);
  } finally {
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
  }
}

async function restoreCommand() {
  const config = getConfig();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-"));
  const archivePath = path.join(tempDir, BACKUP_OBJECT);
  try {
    const found = await downloadFromSupabase(config, archivePath);
    if (!found) {
      return; // First boot: nothing to restore.
    }
    await verifyArchive(archivePath);
    await extractPayloadToRoot(tempDir, archivePath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "backup") {
    await backupCommand();
  } else if (command === "restore") {
    await restoreCommand();
  } else {
    fail(`Unknown command: ${command ?? "(none)"}. Use "backup" or "restore".`);
  }
}

main().catch((err) => fail("Unexpected failure", err));

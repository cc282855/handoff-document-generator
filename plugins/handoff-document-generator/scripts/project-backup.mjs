import { constants as fsConstants } from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";

export const BACKUP_MAX_FILES = 50_000;
export const BACKUP_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const BACKUP_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const BACKUP_MAX_DEPTH = 64;
export const BACKUP_MAX_RELATIVE_PATH = 4096;
export const BACKUP_DEADLINE_MS = 2 * 60 * 60 * 1000;
export const BACKUP_LOCK_STALE_MS = 10 * 60 * 1000;

const BUFFER_BYTES = 1024 * 1024;
const TEXT_OVERLAP = 512;
const HASH_RE = /^[a-f0-9]{64}$/u;
const SHORT_ID_RE = /^[a-f0-9]{16}$/u;
const OPERATION_RE = /^[a-f0-9]{32}$/u;
const ROOT_ID_RE = /^[a-f0-9]{32}$/u;
const ROOT_MARKER = ".handoff-backup-root-v1.json";
const ROOT_MARKER_INIT_LOCK = ".handoff-backup-root-v1.init.lock";
const ROOT_MARKER_INIT_STALE_MS = 30 * 1000;
const ROOT_MARKER_WAIT_ATTEMPTS = 200;
const FILES_DIRECTORY = "项目文件";
const DOCUMENTATION_FILE = "备份说明.md";
const MANIFEST_FILE = "备份清单.json";
const CHECKSUM_FILE = "文件校验.sha256";
const RECEIPT_FILE = "备份回执.json";
const OWNER_FILE = ".backup-owner.json";
const ROOT_FILES = [DOCUMENTATION_FILE, MANIFEST_FILE, CHECKSUM_FILE, RECEIPT_FILE];

const DENIED_DIRECTORIES = new Map([
  [".git", "DENY_VCS"], [".hg", "DENY_VCS"], [".svn", "DENY_VCS"],
  ["node_modules", "DENY_DEPENDENCIES"], ["bower_components", "DENY_DEPENDENCIES"],
  ["jspm_packages", "DENY_DEPENDENCIES"], ["vendor", "DENY_DEPENDENCIES"],
  [".venv", "DENY_VIRTUALENV"], ["venv", "DENY_VIRTUALENV"], ["__pycache__", "DENY_CACHE"],
  [".tox", "DENY_CACHE"], [".nox", "DENY_CACHE"], [".pytest_cache", "DENY_CACHE"],
  [".mypy_cache", "DENY_CACHE"], [".ruff_cache", "DENY_CACHE"], [".cache", "DENY_CACHE"],
  ["cache", "DENY_CACHE"], ["caches", "DENY_CACHE"], ["build", "DENY_BUILD"],
  ["dist", "DENY_BUILD"], ["out", "DENY_BUILD"], ["target", "DENY_BUILD"],
  ["coverage", "DENY_COVERAGE"], [".nyc_output", "DENY_COVERAGE"],
  ["tmp", "DENY_TEMP"], ["temp", "DENY_TEMP"], [".tmp", "DENY_TEMP"],
  ["logs", "DENY_LOGS"], ["log", "DENY_LOGS"], ["sessions", "DENY_SESSION_DATA"],
  ["session", "DENY_SESSION_DATA"], ["plugin-data", "DENY_PLUGIN_DATA"],
  ["broker", "DENY_BROKER_DATA"], ["brokers", "DENY_BROKER_DATA"],
  ["rollouts", "DENY_TRANSCRIPTS"], ["transcripts", "DENY_TRANSCRIPTS"],
  ["credentials", "DENY_CREDENTIAL_STORE"], ["secrets", "DENY_CREDENTIAL_STORE"],
  ["cookies", "DENY_CREDENTIAL_STORE"], ["tokens", "DENY_CREDENTIAL_STORE"],
  [".npm", "DENY_PACKAGE_CACHE"], [".yarn", "DENY_PACKAGE_CACHE"],
  [".pnpm-store", "DENY_PACKAGE_CACHE"], ["pip-cache", "DENY_PACKAGE_CACHE"],
  ["项目备份", "DENY_BACKUP_OUTPUT"],
]);

const DENIED_EXTENSIONS = new Map([
  [".pem", "DENY_PRIVATE_KEY"], [".key", "DENY_PRIVATE_KEY"],
  [".p12", "DENY_KEYSTORE"], [".pfx", "DENY_KEYSTORE"], [".jks", "DENY_KEYSTORE"],
  [".keystore", "DENY_KEYSTORE"], [".crt", "DENY_CERTIFICATE"], [".cer", "DENY_CERTIFICATE"],
  [".db", "DENY_DATABASE"], [".sqlite", "DENY_DATABASE"], [".sqlite3", "DENY_DATABASE"],
  [".log", "DENY_LOGS"], [".dump", "DENY_DUMP"], [".dmp", "DENY_DUMP"],
  [".zip", "DENY_ARCHIVE"], [".7z", "DENY_ARCHIVE"], [".rar", "DENY_ARCHIVE"],
  [".tar", "DENY_ARCHIVE"], [".gz", "DENY_ARCHIVE"], [".tgz", "DENY_ARCHIVE"],
  [".bz2", "DENY_ARCHIVE"], [".xz", "DENY_ARCHIVE"], [".zst", "DENY_ARCHIVE"],
  [".jar", "DENY_ARCHIVE"], [".war", "DENY_ARCHIVE"], [".ear", "DENY_ARCHIVE"],
  [".exe", "DENY_EXECUTABLE"], [".dll", "DENY_EXECUTABLE"], [".so", "DENY_EXECUTABLE"],
  [".dylib", "DENY_EXECUTABLE"], [".msi", "DENY_EXECUTABLE"], [".class", "DENY_EXECUTABLE"],
  [".o", "DENY_EXECUTABLE"], [".obj", "DENY_EXECUTABLE"], [".bin", "DENY_EXECUTABLE"],
  [".wasm", "DENY_EXECUTABLE"],
]);

const SAFE_BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
]);

class BackupError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new BackupError(code);
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function equalHash(left, right) {
  return HASH_RE.test(left || "") && HASH_RE.test(right || "") &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function normalizeAbsolute(value) {
  return process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
}

function equalPath(left, right) {
  return normalizeAbsolute(left) === normalizeAbsolute(right);
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function hasForbiddenUnicode(value) {
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return true;
  for (const character of value) {
    const point = character.codePointAt(0);
    if ((point >= 0xfdd0 && point <= 0xfdef) || (point & 0xffff) === 0xfffe || (point & 0xffff) === 0xffff) return true;
  }
  return false;
}

function stripForbiddenUnicode(value) {
  return [...String(value ?? "")].map((character) => hasForbiddenUnicode(character) ? " " : character).join("");
}

function safeSegment(value) {
  if (typeof value !== "string" || !value || value === "." || value === ".." || value.length > 255 ||
    hasForbiddenUnicode(value) || /[\\/:]/u.test(value) || /[. ]$/u.test(value)) return false;
  const stem = value.split(".")[0];
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem);
}

function safeAbsolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /^(?:\\\\|\/\/)/u.test(value) || hasForbiddenUnicode(value)) return false;
  const parsed = path.parse(path.resolve(value));
  const parts = path.resolve(value).slice(parsed.root.length).split(path.sep).filter(Boolean);
  return parts.every(safeSegment);
}

function safeRelative(value) {
  if (typeof value !== "string" || !value || value.length > BACKUP_MAX_RELATIVE_PATH ||
    value.includes("\\") || value.startsWith("/") || value.endsWith("/")) return null;
  const parts = value.split("/");
  return parts.every(safeSegment) ? parts.join("/") : null;
}

function joinRelative(parent, segment) {
  return parent ? `${parent}/${segment}` : segment;
}

function exclusion(relative, ruleId) {
  return { path_digest: hashBytes(Buffer.from(String(relative), "utf8")), rule_id: ruleId };
}

function safeProjectLabel(value) {
  const normalized = String(value || "项目").normalize("NFC").replace(/\s+/gu, " ").trim();
  return safeSegment(normalized) ? normalized.slice(0, 80) : "项目";
}

function projectIdentityName(workspace) {
  return `project-${hashBytes(Buffer.from(normalizeAbsolute(workspace), "utf8")).slice(0, 16)}（项目备份）`;
}

async function canonicalDirectory(value) {
  if (!safeAbsolutePath(value)) return null;
  try {
    const before = await lstat(value);
    if (!before.isDirectory() || before.isSymbolicLink()) return null;
    const canonical = await realpath(value);
    const after = await stat(canonical);
    if (!equalPath(canonical, value) || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) return null;
    return { path: path.resolve(canonical), dev: before.dev, ino: before.ino };
  } catch {
    return null;
  }
}

async function assertDirectoryIdentity(value, identity, error = "BACKUP_DIRECTORY_CHANGED") {
  const current = await canonicalDirectory(value);
  if (!current || !equalPath(current.path, identity.path) || current.dev !== identity.dev || current.ino !== identity.ino) fail(error);
  return current;
}

async function ensureDirectoryChain(target) {
  if (!safeAbsolutePath(target)) fail("BACKUP_ROOT_UNSAFE");
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    if (!safeSegment(part)) fail("BACKUP_ROOT_UNSAFE");
    current = path.join(current, part);
    let info = await lstat(current).catch(() => null);
    if (!info) {
      await mkdir(current, { mode: 0o700 }).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail("BACKUP_ROOT_UNSAFE");
    const canonical = await realpath(current);
    const canonicalInfo = await stat(canonical);
    if (!equalPath(canonical, current) || canonicalInfo.dev !== info.dev || canonicalInfo.ino !== info.ino) fail("BACKUP_ROOT_UNSAFE");
  }
  return absolute;
}

async function readRegularBytes(file, maximum = 16 * 1024 * 1024) {
  let handle = null;
  try {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) fail("BACKUP_VERIFY_FAILED");
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail("BACKUP_VERIFY_FAILED");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail("BACKUP_SOURCE_CHANGED");
    return { bytes, sha256: hashBytes(bytes), stats: opened };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readRegularJson(file, maximum) {
  const result = await readRegularBytes(file, maximum);
  return { ...result, value: JSON.parse(result.bytes.toString("utf8")) };
}

async function writeExclusive(file, bytes, mode = 0o600) {
  let handle = null;
  try {
    handle = await open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function atomicReplaceJson(file, value) {
  const temporary = `${file}.tmp-${randomBytes(8).toString("hex")}`;
  await writeExclusive(temporary, JSON.stringify(value) + "\n");
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle = null;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES"].includes(error?.code)) throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function validRootMarker(record) {
  return record?.version === 1 && ROOT_ID_RE.test(record.root_id || "") && HASH_RE.test(record.auth_key || "") &&
    typeof record.created_at === "string" && Number.isFinite(Date.parse(record.created_at));
}

function markerProof(markerPath, read) {
  return {
    path: markerPath,
    dev: read.stats.dev,
    ino: read.stats.ino,
    size: read.stats.size,
    mtimeMs: read.stats.mtimeMs,
    sha256: read.sha256,
  };
}

function sameMarkerProof(left, right) {
  return left && right && equalPath(left.path, right.path) && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && equalHash(left.sha256, right.sha256);
}

async function readPublishedRootMarker(markerPath) {
  try {
    const read = await readRegularJson(markerPath, 4096);
    if (!validRootMarker(read.value)) fail("BACKUP_ROOT_MARKER_INVALID");
    return { record: read.value, proof: markerProof(markerPath, read) };
  } catch (error) {
    if (error instanceof BackupError && error.code === "BACKUP_ROOT_MARKER_INVALID") throw error;
    fail("BACKUP_ROOT_MARKER_INVALID");
  }
}

async function writePrivateJson(directory, name, value) {
  const temporary = path.join(directory, `${name}.tmp-${randomBytes(8).toString("hex")}`);
  const target = path.join(directory, name);
  await writeExclusive(temporary, JSON.stringify(value) + "\n");
  try {
    await rename(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function removeRootInitLock(lockDirectory, owner) {
  const identity = await canonicalDirectory(lockDirectory);
  if (!identity) return false;
  const current = (await readRegularJson(path.join(lockDirectory, "lock.json"), 4096).catch(() => null))?.value;
  if (current?.owner !== owner) return false;
  const directory = await opendir(lockDirectory);
  try {
    for await (const entry of directory) {
      if (entry.isSymbolicLink() || !entry.isFile() || !["lock.json", "marker.tmp"].includes(entry.name)) return false;
    }
  } finally {
    await directory.close().catch(() => {});
  }
  await unlink(path.join(lockDirectory, "marker.tmp")).catch(() => {});
  await unlink(path.join(lockDirectory, "lock.json"));
  await rmdir(lockDirectory);
  return true;
}

async function retireStaleRootInitLock(root, rootIdentity, lockDirectory, now) {
  const info = await lstat(lockDirectory).catch(() => null);
  const identity = info && !info.isSymbolicLink() && info.isDirectory() ? await canonicalDirectory(lockDirectory) : null;
  if (!identity || !inside(root, identity.path)) fail("BACKUP_ROOT_MARKER_INIT_INCONSISTENT");
  const current = (await readRegularJson(path.join(lockDirectory, "lock.json"), 4096).catch(() => null))?.value;
  const valid = current?.version === 1 && OPERATION_RE.test(current.owner || "") && Number.isFinite(current.heartbeat_at);
  const heartbeat = valid ? current.heartbeat_at : info.mtimeMs;
  if (now - heartbeat <= ROOT_MARKER_INIT_STALE_MS) return false;
  const quarantine = path.join(root, `.stale-root-marker-init-${randomBytes(8).toString("hex")}`);
  await assertDirectoryIdentity(root, rootIdentity, "BACKUP_ROOT_CHANGED");
  await rename(lockDirectory, quarantine).catch((error) => {
    if (["ENOENT", "EEXIST"].includes(error?.code)) fail("BACKUP_BUSY");
    throw error;
  });
  try {
    const movedIdentity = await canonicalDirectory(quarantine);
    if (!movedIdentity || movedIdentity.dev !== identity.dev || movedIdentity.ino !== identity.ino) fail("BACKUP_ROOT_MARKER_INIT_INCONSISTENT");
    const directory = await opendir(quarantine);
    try {
      for await (const entry of directory) {
        if (entry.isSymbolicLink() || !entry.isFile() ||
          !(entry.name === "lock.json" || entry.name === "marker.tmp" || /^lock\.json\.tmp-[a-f0-9]{16}$/u.test(entry.name))) {
          fail("BACKUP_ROOT_MARKER_INIT_INCONSISTENT");
        }
      }
    } finally {
      await directory.close().catch(() => {});
    }
    await rm(quarantine, { recursive: true, force: false });
    await syncDirectory(root);
    return true;
  } catch (error) {
    if (!await lstat(lockDirectory).catch(() => null)) await rename(quarantine, lockDirectory).catch(() => {});
    throw error;
  }
}

async function ensureRootMarker(root, rootIdentity) {
  const markerPath = path.join(root, ROOT_MARKER);
  const lockDirectory = path.join(root, ROOT_MARKER_INIT_LOCK);
  for (let attempt = 0; attempt < ROOT_MARKER_WAIT_ATTEMPTS; attempt += 1) {
    if (await lstat(markerPath).catch(() => null)) return readPublishedRootMarker(markerPath);
    const owner = randomBytes(16).toString("hex");
    let acquired = false;
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      acquired = true;
      const lockValue = { version: 1, owner, heartbeat_at: Date.now() };
      await writePrivateJson(lockDirectory, "lock.json", lockValue);
      const record = {
        version: 1,
        root_id: randomBytes(16).toString("hex"),
        auth_key: randomBytes(32).toString("hex"),
        created_at: new Date().toISOString(),
      };
      const markerBytes = Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8");
      const temporary = path.join(lockDirectory, "marker.tmp");
      await writeExclusive(temporary, markerBytes);
      await assertDirectoryIdentity(root, rootIdentity, "BACKUP_ROOT_CHANGED");
      try {
        await link(temporary, markerPath);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      await unlink(temporary).catch(() => {});
      await syncDirectory(root);
      const published = await readPublishedRootMarker(markerPath);
      if (!equalHash(published.proof.sha256, hashBytes(markerBytes))) fail("BACKUP_ROOT_MARKER_INVALID");
      await removeRootInitLock(lockDirectory, owner);
      acquired = false;
      return published;
    } catch (error) {
      if (acquired) await removeRootInitLock(lockDirectory, owner).catch(() => false);
      if (error?.code !== "EEXIST") throw error;
    }
    if (await lstat(markerPath).catch(() => null)) return readPublishedRootMarker(markerPath);
    if (await retireStaleRootInitLock(root, rootIdentity, lockDirectory, Date.now())) continue;
    if (attempt + 1 < ROOT_MARKER_WAIT_ATTEMPTS) await delay(10);
  }
  fail("BACKUP_BUSY");
}

async function assertRootMarkerProof(context, error = "BACKUP_ROOT_MARKER_CHANGED") {
  const current = await readPublishedRootMarker(context.markerProof.path).catch(() => null);
  if (!current || !sameMarkerProof(current.proof, context.markerProof) ||
    current.record.root_id !== context.marker.root_id || current.record.auth_key !== context.marker.auth_key) fail(error);
  return current;
}

async function resolveBackupContext(workspaceRoot, options = {}) {
  const workspaceIdentity = await canonicalDirectory(workspaceRoot);
  if (!workspaceIdentity) fail("BACKUP_WORKSPACE_UNSAFE");
  const environment = options.env ?? process.env;
  const configured = environment.CODEX_HANDOFF_BACKUP_ROOT;
  let candidate = null;
  if (configured !== undefined && configured !== "") {
    if (!safeAbsolutePath(configured)) fail("BACKUP_ROOT_UNSAFE");
    candidate = path.resolve(configured);
  } else {
    let cursor = workspaceIdentity.path;
    while (true) {
      const identity = await canonicalDirectory(cursor);
      if (!identity) fail("BACKUP_ROOT_UNSAFE");
      if (path.basename(identity.path).normalize("NFC") === "CODEX存储目录") {
        candidate = path.join(identity.path, "项目备份");
        break;
      }
      if (options.testing === true && options.ancestorBoundary && equalPath(identity.path, options.ancestorBoundary)) break;
      const parent = path.dirname(identity.path);
      if (equalPath(parent, identity.path)) break;
      cursor = parent;
    }
  }
  if (!candidate) fail("BACKUP_ROOT_CONFIGURATION_REQUIRED");
  if (inside(workspaceIdentity.path, candidate) || inside(candidate, workspaceIdentity.path)) fail("BACKUP_ROOT_OVERLAP");
  const root = await ensureDirectoryChain(candidate);
  const rootIdentity = await canonicalDirectory(root);
  if (!rootIdentity || inside(workspaceIdentity.path, root) || inside(root, workspaceIdentity.path)) fail("BACKUP_ROOT_OVERLAP");
  const markerState = await ensureRootMarker(root, rootIdentity);
  await assertDirectoryIdentity(root, rootIdentity, "BACKUP_ROOT_CHANGED");
  return { workspaceIdentity, rootIdentity, marker: markerState.record, markerProof: markerState.proof };
}

export async function resolveBackupRoot(workspaceRoot, options = {}) {
  return (await resolveBackupContext(workspaceRoot, options)).rootIdentity.path;
}

function directoryDenyRule(relative) {
  const parts = relative.toLowerCase().split("/");
  if (parts[0] === ".codex" && parts.slice(1).some((part) => ["state", "plugin", "plugins", "plugin-data", "sessions", "session", "broker", "brokers"].includes(part))) return "DENY_CODEX_RUNTIME";
  for (const part of parts) {
    const rule = DENIED_DIRECTORIES.get(part);
    if (rule) return rule;
  }
  return null;
}

function fileDenyRule(relative) {
  const parts = relative.toLowerCase().split("/");
  if (parts[0] === ".codex" && parts.slice(1).some((part) => ["state", "plugin", "plugins", "plugin-data", "sessions", "session", "broker", "brokers"].includes(part))) return "DENY_CODEX_RUNTIME";
  const base = parts.at(-1);
  if (base.startsWith(".env")) return "DENY_ENV_FILE";
  if ([".npmrc", ".pypirc", ".netrc"].includes(base)) return "DENY_CREDENTIAL_STORE";
  if (/^(?:auth|authorization|credential|credentials|cookie|cookies|token|tokens|secret|secrets)(?:\.[a-z0-9_.-]+)?$/iu.test(base)) return "DENY_CREDENTIAL_STORE";
  if (/(?:^|[-_.])(?:auth|authorization|credentials?|cookies?|tokens?|secrets?)(?:[-_.]|$)/iu.test(base) && /\.(?:json|ya?ml|toml|ini|txt|dat|store|vault)$/iu.test(base)) return "DENY_CREDENTIAL_STORE";
  if (/(?:^|[-_.])(?:rollout|transcript)(?:[-_.]|$)/iu.test(base)) return "DENY_TRANSCRIPTS";
  if (/(?:\.db|\.sqlite|\.sqlite3)-(?:wal|shm)$/iu.test(base)) return "DENY_DATABASE";
  return DENIED_EXTENSIONS.get(path.extname(base).toLowerCase()) || null;
}

function looksText(bytes, extension) {
  if ([".svg", ".xml", ".json", ".md", ".txt", ".yaml", ".yml", ".toml", ".ini", ".csv"].includes(extension)) return true;
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let controls = 0;
    for (const byte of bytes) if (byte < 32 && ![9, 10, 12, 13].includes(byte)) controls += 1;
    return bytes.length === 0 || controls / bytes.length < 0.01;
  } catch {
    return false;
  }
}

function uniqueRules(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string"))].sort();
}

function metadataRules(value, options) {
  return uniqueRules(options.scanText(String(value), options.capabilities));
}

function checkDeadline(transaction) {
  if (transaction.signal?.aborted) fail("BACKUP_CANCELLED");
  if (Date.now() > transaction.deadline) fail("BACKUP_DEADLINE_EXCEEDED");
}

async function canonicalFilePath(source, workspace) {
  const canonical = await realpath(source).catch(() => null);
  if (!canonical || !equalPath(canonical, source) || !inside(workspace, canonical)) fail("BACKUP_SOURCE_PATH_CHANGED");
  return canonical;
}

async function scanOpenHandle(handle, opened, relative, options, heartbeat) {
  const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
  const extension = path.extname(relative).toLowerCase();
  let offset = 0;
  let prefix = Buffer.alloc(0);
  let rawOverlap = "";
  let textOverlap = "";
  let decoder = null;
  let text = null;
  const rules = new Set();
  const hash = createHash("sha256");
  while (offset < opened.size) {
    checkDeadline(options.transaction);
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
    if (!bytesRead) fail("BACKUP_SOURCE_CHANGED");
    const bytes = buffer.subarray(0, bytesRead);
    if (offset === 0) {
      prefix = Buffer.from(bytes);
      text = looksText(prefix, extension);
      decoder = text ? new StringDecoder("utf8") : null;
      if (!text && !SAFE_BINARY_EXTENSIONS.has(extension)) return { excluded: ["DENY_UNSAFE_BINARY"] };
    }
    hash.update(bytes);
    const raw = rawOverlap + bytes.toString("latin1");
    for (const rule of options.scanCapabilityBytes(raw, options.capabilities)) rules.add(rule);
    rawOverlap = raw.slice(-TEXT_OVERLAP);
    if (decoder) {
      const decoded = textOverlap + decoder.write(bytes);
      for (const rule of options.scanText(decoded, options.capabilities)) rules.add(rule);
      textOverlap = decoded.slice(-TEXT_OVERLAP);
    }
    offset += bytesRead;
    await heartbeat();
  }
  if (opened.size === 0) text = true;
  if (decoder) for (const rule of options.scanText(textOverlap + decoder.end(), options.capabilities)) rules.add(rule);
  const after = await handle.stat();
  if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail("BACKUP_SOURCE_CHANGED");
  return { rules: [...rules].sort(), sha256: hash.digest("hex"), bytes: opened.size, type: text ? "text" : "binary-resource" };
}

async function copySafeFile(source, destination, relative, workspace, expectedInfo, options, heartbeat) {
  let sourceHandle = null;
  let destinationHandle = null;
  try {
    await canonicalFilePath(source, workspace);
    if (options.testing === true && typeof options.onBeforeSourceOpen === "function") await options.onBeforeSourceOpen(relative, source);
    const before = await lstat(source);
    if (!before.isFile() || before.isSymbolicLink()) return { excluded: ["DENY_NON_REGULAR"] };
    if (before.dev !== expectedInfo.dev || before.ino !== expectedInfo.ino || before.size !== expectedInfo.size || before.mtimeMs !== expectedInfo.mtimeMs) fail("BACKUP_SOURCE_CHANGED");
    if (before.size > options.limits.maxFileBytes) fail("BACKUP_FILE_QUOTA_EXCEEDED");
    sourceHandle = await open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    await canonicalFilePath(source, workspace);
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail("BACKUP_SOURCE_CHANGED");

    // Pass one scans the verified source handle completely. No destination exists yet.
    const scanned = await scanOpenHandle(sourceHandle, opened, relative, options, heartbeat);
    if (scanned.excluded || scanned.rules?.length) return { excluded: scanned.excluded || scanned.rules };
    if (options.testing === true && typeof options.afterCandidateScan === "function") await options.afterCandidateScan(relative, destination);
    await canonicalFilePath(source, workspace);
    const beforeCopy = await sourceHandle.stat();
    if (beforeCopy.dev !== opened.dev || beforeCopy.ino !== opened.ino || beforeCopy.size !== opened.size || beforeCopy.mtimeMs !== opened.mtimeMs) fail("BACKUP_SOURCE_CHANGED");

    await ensureOutputParents(destination, options.filesRoot, options.createdDirectories);
    destinationHandle = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
    const copiedHash = createHash("sha256");
    let offset = 0;
    while (offset < opened.size) {
      checkDeadline(options.transaction);
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (!bytesRead) fail("BACKUP_SOURCE_CHANGED");
      const bytes = buffer.subarray(0, bytesRead);
      await destinationHandle.write(bytes, 0, bytes.length, offset);
      copiedHash.update(bytes);
      offset += bytesRead;
      await heartbeat();
    }
    const after = await sourceHandle.stat();
    await canonicalFilePath(source, workspace);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || copiedHash.digest("hex") !== scanned.sha256) fail("BACKUP_SOURCE_CHANGED");
    await destinationHandle.sync();
    return { sha256: scanned.sha256, bytes: scanned.bytes, type: scanned.type };
  } finally {
    if (sourceHandle) await sourceHandle.close().catch(() => {});
    if (destinationHandle) await destinationHandle.close().catch(() => {});
  }
}

async function ensureOutputParents(destination, filesRoot, createdDirectories) {
  const relativeParent = path.relative(filesRoot, path.dirname(destination));
  if (!relativeParent) return;
  let current = filesRoot;
  let relative = "";
  for (const segment of relativeParent.split(path.sep)) {
    if (!safeSegment(segment)) fail("BACKUP_UNSAFE_RELATIVE_PATH");
    current = path.join(current, segment);
    relative = joinRelative(relative, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await canonicalDirectory(current);
      if (!existing) fail("BACKUP_OUTPUT_CHANGED");
    }
    createdDirectories.add(relative);
  }
}

async function freeSpaceCheck(root, required) {
  try {
    const value = await statfs(root, { bigint: true });
    const available = value.bavail * value.bsize;
    if (available < BigInt(required) + 64n * 1024n * 1024n) fail("BACKUP_INSUFFICIENT_SPACE");
  } catch (error) {
    if (error instanceof BackupError) throw error;
    // statfs is advisory and unavailable on some supported filesystems.
  }
}

function chineseTimestamp(date) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).reduce((result, item) => ({ ...result, [item.type]: item.value }), {});
  return `${parts.year}年${parts.month}月${parts.day}日-${parts.hour}时${parts.minute}分${parts.second}秒`;
}

function backupDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (Number.isFinite(value)) return new Date(value);
  return new Date();
}

function markdownText(value) {
  return stripForbiddenUnicode(value).normalize("NFC")
    .replace(/([\\`*_{}\[\]()#+.!|<>~-])/gu, "\\$1").replace(/\s+/gu, " ").trim();
}

function markdownCode(value) {
  return stripForbiddenUnicode(value).normalize("NFC")
    .replace(/`/gu, "\\`").replace(/\s+/gu, " ").trim();
}

function documentationText(input) {
  const purpose = markdownText(input.purpose) || "保存交接时刻的普通安全项目文件，供核验、恢复和后续部署。";
  const rules = [...new Set(input.exclusions.map((item) => item.rule_id))].sort();
  return [
    "# 项目备份说明", "", "## 用途", "", purpose, "", "## 源与备份映射", "",
    `- 项目标签：${markdownText(input.projectLabel)}`,
    `- 源项目：\`${markdownCode(input.workspace)}\``,
    `- 备份快照：\`${markdownCode(input.snapshot)}\``,
    `- 项目文件目录：\`${markdownCode(path.join(input.snapshot, FILES_DIRECTORY))}\``,
    `- HANDOFF SHA-256：\`${input.documentSha256}\``, "", "## 纳入与排除", "",
    `- 已纳入 ${input.files.length} 个普通安全文件。`,
    `- 已排除 ${input.exclusions.length} 个路径；清单仅保存不可逆路径摘要和规则 ID。`,
    `- 排除规则：${rules.length ? rules.map((rule) => `\`${rule}\``).join("、") : "无"}。`,
    "- 固定排除版本库、Codex 运行态、依赖、缓存、构建、临时、日志、数据库、归档、可执行文件、密钥和凭据。", "",
    "## 完整性说明", "",
    "备份回执、清单和校验文件共同绑定精确目录树。校验只能证明快照发布后未变化，不能证明源项目没有逻辑缺陷或同一操作系统用户没有篡改本地文件。", "",
    "## 恢复、安装、测试与部署", "",
    "1. 先核验备份回执、清单和 `文件校验.sha256`，再把 `项目文件` 复制到新的空目录。",
    "2. 按 README、清单和锁文件重新安装依赖；不要恢复依赖目录。",
    "3. 从可信密钥系统重新注入敏感配置，并运行项目规定的完整测试。",
    "4. 仅在代码审查、依赖审计、测试和目标环境核对通过后部署。", "",
  ].join("\n");
}

function receiptSignature(value, authKey) {
  const payload = [value.version, value.root_id, value.snapshot_id, value.idempotency_key, value.manifest_sha256, value.checksum_sha256].join("\n");
  return createHmac("sha256", Buffer.from(authKey, "hex")).update(payload, "utf8").digest("hex");
}

function returnedReceipt(snapshot, value) {
  return {
    backup_path: snapshot,
    backup_root_id: value.root_id,
    backup_manifest_sha256: value.manifest_sha256,
    backup_checksum_sha256: value.checksum_sha256,
    backup_document_sha256: value.document_sha256,
    backup_snapshot_id: value.snapshot_id,
    backup_idempotency_key: value.idempotency_key,
  };
}

async function hashRegularFile(file, maximum = BACKUP_MAX_FILE_BYTES) {
  let handle = null;
  try {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) fail("BACKUP_VERIFY_FAILED");
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail("BACKUP_VERIFY_FAILED");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (!bytesRead) fail("BACKUP_VERIFY_FAILED");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail("BACKUP_SOURCE_CHANGED");
    return { sha256: hash.digest("hex"), bytes: opened.size };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function enumerateExactTree(tree, expectedFiles, expectedDirectories) {
  const seenFiles = new Set();
  const seenDirectories = new Set();
  const stack = [{ absolute: tree, relative: "", depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    if (current.depth > BACKUP_MAX_DEPTH + 2) fail("BACKUP_RECEIPT_INVALID");
    const identity = await canonicalDirectory(current.absolute);
    if (!identity || !inside(tree, identity.path)) fail("BACKUP_RECEIPT_INVALID");
    const directory = await opendir(current.absolute);
    try {
      for await (const entry of directory) {
        await assertDirectoryIdentity(current.absolute, identity, "BACKUP_RECEIPT_INVALID");
        if (!safeSegment(entry.name)) fail("BACKUP_RECEIPT_INVALID");
        const relative = joinRelative(current.relative, entry.name);
        const target = path.join(current.absolute, entry.name);
        const info = await lstat(target);
        if (info.isSymbolicLink()) fail("BACKUP_RECEIPT_INVALID");
        if (info.isDirectory()) {
          if (!expectedDirectories.has(relative) || seenDirectories.has(relative)) fail("BACKUP_RECEIPT_INVALID");
          seenDirectories.add(relative);
          stack.push({ absolute: target, relative, depth: current.depth + 1 });
        } else if (info.isFile()) {
          if (!expectedFiles.has(relative) || seenFiles.has(relative)) fail("BACKUP_RECEIPT_INVALID");
          await canonicalFilePath(target, tree).catch(() => fail("BACKUP_RECEIPT_INVALID"));
          seenFiles.add(relative);
        } else fail("BACKUP_RECEIPT_INVALID");
      }
    } finally {
      await directory.close().catch(() => {});
    }
    await assertDirectoryIdentity(current.absolute, identity, "BACKUP_RECEIPT_INVALID");
  }
  if (seenFiles.size !== expectedFiles.size || seenDirectories.size !== expectedDirectories.size) fail("BACKUP_RECEIPT_INVALID");
}

async function verifySnapshotTree(tree, receipt, expected, context, options = {}) {
  const manifestRead = await readRegularJson(path.join(tree, MANIFEST_FILE), 32 * 1024 * 1024);
  if (options.testing === true && typeof options.afterManifestRead === "function") await options.afterManifestRead(tree, manifestRead);
  if (!equalHash(manifestRead.sha256, receipt.backup_manifest_sha256)) fail("BACKUP_RECEIPT_INVALID");
  const manifest = manifestRead.value;
  if (manifest?.version !== 2 || !equalPath(manifest.source_workspace, expected.workspaceRoot) ||
    !equalPath(manifest.backup_snapshot, receipt.backup_path) || manifest.root_id !== context.marker.root_id ||
    manifest.document_sha256 !== expected.documentSha256 || manifest.snapshot_id !== receipt.backup_snapshot_id ||
    manifest.idempotency_key !== receipt.backup_idempotency_key || !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.directories) || manifest.files.length > BACKUP_MAX_FILES) fail("BACKUP_RECEIPT_INVALID");

  const receiptRead = await readRegularJson(path.join(tree, RECEIPT_FILE), 64 * 1024);
  const signed = receiptRead.value;
  if (signed?.version !== 1 || signed.root_id !== context.marker.root_id || signed.snapshot_id !== manifest.snapshot_id ||
    signed.idempotency_key !== manifest.idempotency_key || signed.manifest_sha256 !== manifestRead.sha256 ||
    signed.checksum_sha256 !== receipt.backup_checksum_sha256 || signed.document_sha256 !== manifest.document_sha256 ||
    !equalHash(signed.signature, receiptSignature(signed, context.marker.auth_key))) fail("BACKUP_RECEIPT_INVALID");

  const documentation = await hashRegularFile(path.join(tree, DOCUMENTATION_FILE), 16 * 1024 * 1024);
  if (!equalHash(documentation.sha256, manifest.documentation_sha256)) fail("BACKUP_RECEIPT_INVALID");
  const checksumRead = await readRegularBytes(path.join(tree, CHECKSUM_FILE), 32 * 1024 * 1024);
  if (!equalHash(checksumRead.sha256, receipt.backup_checksum_sha256)) fail("BACKUP_RECEIPT_INVALID");
  const checksums = new Map();
  for (const line of checksumRead.bytes.toString("utf8").split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/u);
    if (!match || !safeRelative(match[2]) || checksums.has(match[2])) fail("BACKUP_RECEIPT_INVALID");
    checksums.set(match[2], match[1]);
  }

  const expectedFiles = new Map([
    [DOCUMENTATION_FILE, manifest.documentation_sha256], [MANIFEST_FILE, manifestRead.sha256],
    [CHECKSUM_FILE, checksumRead.sha256], [RECEIPT_FILE, receiptRead.sha256],
  ]);
  const expectedDirectories = new Set([FILES_DIRECTORY]);
  const manifestPaths = new Set();
  for (const directory of manifest.directories) {
    if (!safeRelative(directory) || manifestPaths.has("d:" + directory)) fail("BACKUP_RECEIPT_INVALID");
    manifestPaths.add("d:" + directory);
    expectedDirectories.add(`${FILES_DIRECTORY}/${directory}`);
  }
  for (const item of manifest.files) {
    if (!safeRelative(item?.path) || !HASH_RE.test(item?.sha256 || "") || !Number.isSafeInteger(item?.bytes) ||
      item.bytes < 0 || item.bytes > BACKUP_MAX_FILE_BYTES || !["text", "binary-resource"].includes(item?.type) ||
      manifestPaths.has("f:" + item.path)) fail("BACKUP_RECEIPT_INVALID");
    manifestPaths.add("f:" + item.path);
    expectedFiles.set(`${FILES_DIRECTORY}/${item.path}`, item.sha256);
  }
  if (checksums.size !== manifest.files.length + 2 || checksums.get(DOCUMENTATION_FILE) !== manifest.documentation_sha256 ||
    checksums.get(MANIFEST_FILE) !== manifestRead.sha256) fail("BACKUP_RECEIPT_INVALID");
  for (const item of manifest.files) if (checksums.get(`${FILES_DIRECTORY}/${item.path}`) !== item.sha256) fail("BACKUP_RECEIPT_INVALID");

  await enumerateExactTree(tree, new Set(expectedFiles.keys()), expectedDirectories);
  for (const [relative, digest] of expectedFiles) {
    if (relative === CHECKSUM_FILE || relative === RECEIPT_FILE) continue;
    const actual = await hashRegularFile(path.join(tree, ...relative.split("/")));
    if (!equalHash(actual.sha256, digest)) fail("BACKUP_RECEIPT_INVALID");
  }
  const manifestAgain = await readRegularBytes(path.join(tree, MANIFEST_FILE), 32 * 1024 * 1024);
  const checksumAgain = await readRegularBytes(path.join(tree, CHECKSUM_FILE), 32 * 1024 * 1024);
  if (!equalHash(manifestAgain.sha256, manifestRead.sha256) || !equalHash(checksumAgain.sha256, checksumRead.sha256)) fail("BACKUP_RECEIPT_INVALID");
  return { manifest, signed };
}

export async function verifyBackupReceipt(receipt, expected = {}, options = {}) {
  try {
    if (!receipt || typeof receipt !== "object" || !safeAbsolutePath(receipt.backup_path) ||
      !ROOT_ID_RE.test(receipt.backup_root_id || "") || !HASH_RE.test(receipt.backup_manifest_sha256 || "") ||
      !HASH_RE.test(receipt.backup_checksum_sha256 || "") || !HASH_RE.test(receipt.backup_document_sha256 || "") ||
      !SHORT_ID_RE.test(receipt.backup_snapshot_id || "") || !HASH_RE.test(receipt.backup_idempotency_key || "") ||
      !safeAbsolutePath(expected.workspaceRoot) || !HASH_RE.test(expected.documentSha256 || "")) return { ok: false, error: "BACKUP_RECEIPT_INVALID" };
    const context = await resolveBackupContext(expected.workspaceRoot, options);
    if (context.marker.root_id !== receipt.backup_root_id || receipt.backup_document_sha256 !== expected.documentSha256) return { ok: false, error: "BACKUP_RECEIPT_INVALID" };
    const projectDirectory = path.join(context.rootIdentity.path, projectIdentityName(context.workspaceIdentity.path));
    if (!inside(projectDirectory, receipt.backup_path) || equalPath(projectDirectory, receipt.backup_path)) return { ok: false, error: "BACKUP_RECEIPT_INVALID" };
    const snapshotIdentity = await canonicalDirectory(receipt.backup_path);
    if (!snapshotIdentity || !equalPath(snapshotIdentity.path, receipt.backup_path)) return { ok: false, error: "BACKUP_RECEIPT_INVALID" };
    if (expected.idempotencyKey && expected.idempotencyKey !== receipt.backup_idempotency_key) return { ok: false, error: "BACKUP_RECEIPT_INVALID" };
    await verifySnapshotTree(snapshotIdentity.path, receipt, expected, context, options);
    await assertRootMarkerProof(context, "BACKUP_ROOT_MARKER_CHANGED");
    return { ok: true, receipt };
  } catch {
    return { ok: false, error: "BACKUP_RECEIPT_INVALID" };
  }
}

function lockValue(operationId, owner, workspaceHash, partialName, finalName, now) {
  return { version: 1, operation_id: operationId, owner, workspace_hash: workspaceHash, partial_name: partialName, final_name: finalName, heartbeat_at: now };
}

function validLock(value, stableId, workspaceHash = null) {
  return value?.version === 1 && OPERATION_RE.test(value.operation_id || "") && OPERATION_RE.test(value.owner || "") &&
    SHORT_ID_RE.test(value.workspace_hash || "") && typeof value.partial_name === "string" &&
    (!workspaceHash || value.workspace_hash === workspaceHash) &&
    value.partial_name === `.partial-${value.operation_id}-${stableId}` && safeSegment(value.final_name) &&
    new RegExp(`^\\d{4}年\\d{2}月\\d{2}日-\\d{2}时\\d{2}分\\d{2}秒-${stableId}$`, "u").test(value.final_name) && Number.isFinite(value.heartbeat_at);
}

async function cleanupOwnedPartial(projectDirectory, projectIdentity, lock, stableId) {
  const workspaceHash = path.basename(projectDirectory).match(/^project-([a-f0-9]{16})（项目备份）$/u)?.[1];
  if (!workspaceHash || !validLock(lock, stableId, workspaceHash)) fail("BACKUP_RECOVERY_UNSAFE");
  await assertDirectoryIdentity(projectDirectory, projectIdentity, "BACKUP_RECOVERY_UNSAFE");
  const partial = path.join(projectDirectory, lock.partial_name);
  const sidecar = path.join(projectDirectory, `${lock.partial_name}.owner.json`);
  const sidecarValue = (await readRegularJson(sidecar, 4096)).value;
  if (sidecarValue?.version !== 1 || sidecarValue.owner !== lock.owner || sidecarValue.operation_id !== lock.operation_id ||
    sidecarValue.partial_name !== lock.partial_name || sidecarValue.final_name !== lock.final_name) fail("BACKUP_RECOVERY_UNSAFE");
  if (!inside(projectDirectory, partial) || !inside(projectDirectory, sidecar)) fail("BACKUP_RECOVERY_UNSAFE");
  const partialIdentity = await canonicalDirectory(partial);
  if (!partialIdentity || !equalPath(partialIdentity.path, partial)) fail("BACKUP_RECOVERY_UNSAFE");
  const internal = await readRegularJson(path.join(partial, OWNER_FILE), 4096).catch(() => null);
  if (internal && (internal.value?.owner !== lock.owner || internal.value?.operation_id !== lock.operation_id)) fail("BACKUP_RECOVERY_UNSAFE");
  await assertDirectoryIdentity(projectDirectory, projectIdentity, "BACKUP_RECOVERY_UNSAFE");
  await assertDirectoryIdentity(partial, partialIdentity, "BACKUP_RECOVERY_UNSAFE");
  await rm(partial, { recursive: true, force: false });
  await unlink(sidecar);
  await assertDirectoryIdentity(projectDirectory, projectIdentity, "BACKUP_RECOVERY_UNSAFE");
}

async function restoreBackupLockQuarantine(quarantine, lockDirectory) {
  if (await lstat(lockDirectory).catch(() => null)) return false;
  await rename(quarantine, lockDirectory).catch(() => {});
  return Boolean(await lstat(lockDirectory).catch(() => null));
}

async function recoverQuarantinedBackupLock(projectDirectory, projectIdentity, quarantine, lockDirectory, existing, stableId, workspaceHash) {
  try {
    const quarantineIdentity = await canonicalDirectory(quarantine);
    if (!quarantineIdentity || !inside(projectDirectory, quarantineIdentity.path)) fail("BACKUP_RECOVERY_UNSAFE");
    if (validLock(existing, stableId, workspaceHash)) {
      const moved = (await readRegularJson(path.join(quarantine, "lock.json"), 4096)).value;
      if (JSON.stringify(moved) !== JSON.stringify(existing)) fail("BACKUP_RECOVERY_UNSAFE");
      const partial = path.join(projectDirectory, moved.partial_name);
      const sidecar = `${partial}.owner.json`;
      const partialInfo = await lstat(partial).catch(() => null);
      const sidecarInfo = await lstat(sidecar).catch(() => null);
      if (Boolean(partialInfo) !== Boolean(sidecarInfo)) fail("BACKUP_LOCK_INITIALIZATION_INCONSISTENT");
      if (partialInfo && sidecarInfo) {
        if (!partialInfo.isDirectory() || partialInfo.isSymbolicLink() || !sidecarInfo.isFile() || sidecarInfo.isSymbolicLink()) {
          fail("BACKUP_LOCK_INITIALIZATION_INCONSISTENT");
        }
        await cleanupOwnedPartial(projectDirectory, projectIdentity, moved, stableId);
      }
    } else {
      const directory = await opendir(quarantine);
      try {
        for await (const entry of directory) {
          if (entry.isSymbolicLink() || !entry.isFile() ||
            !(entry.name === "lock.json" || /^lock\.json\.tmp-[a-f0-9]{16}$/u.test(entry.name))) {
            fail("BACKUP_LOCK_INITIALIZATION_INCONSISTENT");
          }
        }
      } finally {
        await directory.close().catch(() => {});
      }
      const project = await opendir(projectDirectory);
      try {
        for await (const entry of project) {
          if (entry.name.startsWith(".partial-") &&
            (entry.name.endsWith(`-${stableId}`) || entry.name.endsWith(`-${stableId}.owner.json`))) {
            fail("BACKUP_LOCK_INITIALIZATION_INCONSISTENT");
          }
        }
      } finally {
        await project.close().catch(() => {});
      }
    }
    await assertDirectoryIdentity(projectDirectory, projectIdentity, "BACKUP_RECOVERY_UNSAFE");
    await rm(quarantine, { recursive: true, force: false });
    await syncDirectory(projectDirectory);
  } catch (error) {
    await restoreBackupLockQuarantine(quarantine, lockDirectory);
    throw error;
  }
}

async function acquireBackupLock(projectDirectory, projectIdentity, stableId, operationId, finalName, now) {
  const lockDirectory = path.join(projectDirectory, `.backup-${stableId}.lock`);
  const owner = randomBytes(16).toString("hex");
  const workspaceHash = path.basename(projectDirectory).match(/^project-([a-f0-9]{16})（项目备份）$/u)?.[1];
  if (!workspaceHash) fail("BACKUP_ROOT_CHANGED");
  const partialName = `.partial-${operationId}-${stableId}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      const value = lockValue(operationId, owner, workspaceHash, partialName, finalName, now);
      await writePrivateJson(lockDirectory, "lock.json", value);
      return { lockDirectory, value };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockInfo = await lstat(lockDirectory).catch(() => null);
      const lockIdentity = lockInfo && !lockInfo.isSymbolicLink() && lockInfo.isDirectory() ? await canonicalDirectory(lockDirectory) : null;
      if (!lockIdentity || !inside(projectDirectory, lockIdentity.path)) fail("BACKUP_RECOVERY_UNSAFE");
      const existing = (await readRegularJson(path.join(lockDirectory, "lock.json"), 4096).catch(() => null))?.value;
      const heartbeat = validLock(existing, stableId, workspaceHash) ? existing.heartbeat_at : lockInfo.mtimeMs;
      if (Date.now() - heartbeat <= BACKUP_LOCK_STALE_MS) fail("BACKUP_BUSY");
      const quarantine = path.join(projectDirectory, `.stale-lock-${stableId}-${randomBytes(8).toString("hex")}`);
      await assertDirectoryIdentity(projectDirectory, projectIdentity, "BACKUP_RECOVERY_UNSAFE");
      await rename(lockDirectory, quarantine).catch((renameError) => {
        if (["ENOENT", "EEXIST"].includes(renameError?.code)) fail("BACKUP_BUSY");
        throw renameError;
      });
      const quarantineIdentity = await canonicalDirectory(quarantine);
      if (!quarantineIdentity || !equalPath(quarantineIdentity.path, quarantine) ||
        quarantineIdentity.dev !== lockIdentity.dev || quarantineIdentity.ino !== lockIdentity.ino) {
        await restoreBackupLockQuarantine(quarantine, lockDirectory);
        fail("BACKUP_RECOVERY_UNSAFE");
      }
      await recoverQuarantinedBackupLock(projectDirectory, projectIdentity, quarantine, lockDirectory, existing, stableId, workspaceHash);
    }
  }
  fail("BACKUP_BUSY");
}

async function heartbeatLock(lock, transaction) {
  const now = Date.now();
  if (now - transaction.lastHeartbeat < 2000) return;
  checkDeadline(transaction);
  const current = (await readRegularJson(path.join(lock.lockDirectory, "lock.json"), 4096)).value;
  if (current.owner !== lock.value.owner || current.operation_id !== lock.value.operation_id) fail("BACKUP_LOCK_LOST");
  lock.value.heartbeat_at = now;
  await atomicReplaceJson(path.join(lock.lockDirectory, "lock.json"), lock.value);
  transaction.lastHeartbeat = now;
}

async function releaseBackupLock(lock, projectDirectory, projectIdentity) {
  if (projectDirectory && projectIdentity) await assertDirectoryIdentity(projectDirectory, projectIdentity, "BACKUP_RECOVERY_UNSAFE");
  const current = (await readRegularJson(path.join(lock.lockDirectory, "lock.json"), 4096).catch(() => null))?.value;
  if (!current || current.owner !== lock.value.owner || current.operation_id !== lock.value.operation_id) return false;
  const identity = await canonicalDirectory(lock.lockDirectory);
  if (!identity || !equalPath(identity.path, lock.lockDirectory)) return false;
  await rm(lock.lockDirectory, { recursive: true, force: false });
  return true;
}

async function retractOwnedPublished(context, projectDirectory, projectIdentity, lock, sidecar, finalSnapshot, receipt, expected) {
  await assertDirectoryIdentity(context.rootIdentity.path, context.rootIdentity, "BACKUP_RECOVERY_UNSAFE");
  await assertDirectoryIdentity(projectDirectory, projectIdentity, "BACKUP_RECOVERY_UNSAFE");
  if (!inside(context.rootIdentity.path, projectDirectory) || !inside(projectDirectory, finalSnapshot) ||
    !equalPath(path.join(projectDirectory, lock.value.final_name), finalSnapshot)) fail("BACKUP_RECOVERY_UNSAFE");
  const currentLock = (await readRegularJson(path.join(lock.lockDirectory, "lock.json"), 4096)).value;
  if (JSON.stringify(currentLock) !== JSON.stringify(lock.value)) fail("BACKUP_RECOVERY_UNSAFE");
  const owner = (await readRegularJson(sidecar, 4096)).value;
  if (owner?.version !== 1 || owner.owner !== lock.value.owner || owner.operation_id !== lock.value.operation_id ||
    owner.partial_name !== lock.value.partial_name || owner.final_name !== lock.value.final_name) fail("BACKUP_RECOVERY_UNSAFE");
  const snapshotIdentity = await canonicalDirectory(finalSnapshot);
  if (!snapshotIdentity || !equalPath(snapshotIdentity.path, finalSnapshot)) fail("BACKUP_RECOVERY_UNSAFE");
  await verifySnapshotTree(finalSnapshot, receipt, expected, context, {});
  await assertDirectoryIdentity(projectDirectory, projectIdentity, "BACKUP_RECOVERY_UNSAFE");
  await assertDirectoryIdentity(finalSnapshot, snapshotIdentity, "BACKUP_RECOVERY_UNSAFE");
  const quarantine = path.join(projectDirectory, `.retracted-${lock.value.owner}-${receipt.backup_snapshot_id}`);
  if (await lstat(quarantine).catch(() => null)) fail("BACKUP_RECOVERY_UNSAFE");
  await rename(finalSnapshot, quarantine);
  const moved = await canonicalDirectory(quarantine);
  if (!moved || moved.dev !== snapshotIdentity.dev || moved.ino !== snapshotIdentity.ino) fail("BACKUP_RECOVERY_UNSAFE");
  await rm(quarantine, { recursive: true, force: false });
  await unlink(sidecar);
  await syncDirectory(projectDirectory);
}

async function findReusable(projectDirectory, stableId, expected, context, options) {
  const directory = await opendir(projectDirectory);
  const matches = [];
  try {
    for await (const entry of directory) {
      if (!new RegExp(`^\\d{4}年\\d{2}月\\d{2}日-\\d{2}时\\d{2}分\\d{2}秒-${stableId}$`, "u").test(entry.name) || entry.isSymbolicLink()) continue;
      const candidate = path.join(projectDirectory, entry.name);
      const identity = await canonicalDirectory(candidate);
      if (identity) matches.push(identity.path);
    }
  } finally {
    await directory.close().catch(() => {});
  }
  if (matches.length > 1) fail("BACKUP_RECEIPT_CONFLICT");
  if (!matches.length) return null;
  const signed = (await readRegularJson(path.join(matches[0], RECEIPT_FILE), 64 * 1024)).value;
  const receipt = {
    backup_path: matches[0], backup_root_id: signed.root_id,
    backup_manifest_sha256: signed.manifest_sha256, backup_checksum_sha256: signed.checksum_sha256,
    backup_document_sha256: signed.document_sha256, backup_snapshot_id: signed.snapshot_id,
    backup_idempotency_key: signed.idempotency_key,
  };
  const verified = await verifyBackupReceipt(receipt, expected, options);
  if (!verified.ok) fail("BACKUP_RECEIPT_INVALID");
  return { ...receipt, reused: true };
}

function runtimeLimits(options) {
  if (options.testing === true && options.testLimits) return {
    maxFiles: options.testLimits.maxFiles ?? BACKUP_MAX_FILES,
    maxTotalBytes: options.testLimits.maxTotalBytes ?? BACKUP_MAX_TOTAL_BYTES,
    maxFileBytes: options.testLimits.maxFileBytes ?? BACKUP_MAX_FILE_BYTES,
    maxDepth: options.testLimits.maxDepth ?? BACKUP_MAX_DEPTH,
    maxRelativePath: options.testLimits.maxRelativePath ?? BACKUP_MAX_RELATIVE_PATH,
  };
  return { maxFiles: BACKUP_MAX_FILES, maxTotalBytes: BACKUP_MAX_TOTAL_BYTES, maxFileBytes: BACKUP_MAX_FILE_BYTES, maxDepth: BACKUP_MAX_DEPTH, maxRelativePath: BACKUP_MAX_RELATIVE_PATH };
}

export async function createProjectBackup(input, options = {}) {
  let context = null;
  let projectDirectory = null;
  let projectIdentity = null;
  let lock = null;
  let partial = null;
  let sidecar = null;
  let finalSnapshot = null;
  let published = false;
  let cleanupFailed = false;
  try {
    if (!HASH_RE.test(input?.documentSha256 || "") || typeof options.scanText !== "function" || typeof options.scanCapabilityBytes !== "function") fail("BACKUP_REQUEST_INVALID");
    context = await resolveBackupContext(input.workspaceRoot, options);
    const workspace = context.workspaceIdentity.path;
    const workspaceMetadataRules = uniqueRules([
      ...metadataRules(workspace, options), ...metadataRules(context.rootIdentity.path, options),
      ...metadataRules(safeProjectLabel(path.basename(workspace)), options), ...metadataRules(input.purpose || "", options),
    ]);
    if (workspaceMetadataRules.length) fail("BACKUP_METADATA_UNSAFE");
    projectDirectory = await ensureDirectoryChain(path.join(context.rootIdentity.path, projectIdentityName(workspace)));
    projectIdentity = await canonicalDirectory(projectDirectory);
    if (!projectIdentity) fail("BACKUP_ROOT_CHANGED");
    const automatic = typeof input.handoffId === "string" && input.handoffId.length > 0;
    const idempotencyKey = hashBytes(automatic ? Buffer.from(`${input.handoffId}\0${input.documentSha256}`, "utf8") : randomBytes(32));
    const stableId = idempotencyKey.slice(0, 16);
    const expected = { workspaceRoot: workspace, documentSha256: input.documentSha256, idempotencyKey };
    if (automatic) {
      const reusable = await findReusable(projectDirectory, stableId, expected, context, options);
      if (reusable) return { ok: true, ...reusable };
    }
    const operationId = OPERATION_RE.test(input.operationId || "") ? input.operationId : randomBytes(16).toString("hex");
    const created = backupDate(options.now);
    const snapshotName = `${chineseTimestamp(created)}-${stableId}`;
    const transaction = {
      deadline: Date.now() + (Number.isFinite(options.deadlineMs) ? Math.max(1, options.deadlineMs) : BACKUP_DEADLINE_MS),
      signal: options.signal,
      lastHeartbeat: 0,
    };
    lock = await acquireBackupLock(projectDirectory, projectIdentity, stableId, operationId, snapshotName, Date.now());
    const heartbeat = async () => heartbeatLock(lock, transaction);
    partial = path.join(projectDirectory, lock.value.partial_name);
    sidecar = `${partial}.owner.json`;
    const ownership = { version: 1, owner: lock.value.owner, operation_id: operationId, partial_name: lock.value.partial_name, final_name: snapshotName };
    await writeExclusive(sidecar, JSON.stringify(ownership) + "\n");
    await mkdir(partial, { mode: 0o700 });
    await writeExclusive(path.join(partial, OWNER_FILE), JSON.stringify(ownership) + "\n");
    const filesRoot = path.join(partial, FILES_DIRECTORY);
    await mkdir(filesRoot, { mode: 0o700 });
    const limits = runtimeLimits(options);
    const files = [];
    const exclusions = [];
    const createdDirectories = new Set();
    const stack = [{ absolute: workspace, relative: "", depth: 0, expected: context.workspaceIdentity }];
    let visited = 0;
    let totalBytes = 0;
    let handoffDigest = null;
    while (stack.length) {
      checkDeadline(transaction);
      const current = stack.pop();
      if (current.depth > limits.maxDepth) fail("BACKUP_DEPTH_QUOTA_EXCEEDED");
      const directoryIdentity = await canonicalDirectory(current.absolute);
      if (!directoryIdentity || !inside(workspace, directoryIdentity.path) || directoryIdentity.dev !== current.expected.dev || directoryIdentity.ino !== current.expected.ino) fail("BACKUP_DIRECTORY_CHANGED");
      const directory = await opendir(current.absolute);
      try {
        for await (const entry of directory) {
          await heartbeat();
          await assertDirectoryIdentity(current.absolute, directoryIdentity);
          visited += 1;
          if (visited > limits.maxFiles) fail("BACKUP_FILE_QUOTA_EXCEEDED");
          const rawRelative = joinRelative(current.relative, entry.name);
          if (rawRelative.length > limits.maxRelativePath) fail("BACKUP_PATH_QUOTA_EXCEEDED");
          if (!safeSegment(entry.name)) {
            exclusions.push(exclusion(rawRelative, "DENY_UNSAFE_PATH"));
            continue;
          }
          const relative = safeRelative(rawRelative);
          if (!relative) {
            exclusions.push(exclusion(rawRelative, "DENY_UNSAFE_PATH"));
            continue;
          }
          const pathRules = metadataRules(relative, options);
          if (pathRules.length) {
            for (const rule of pathRules) exclusions.push(exclusion(relative, rule));
            continue;
          }
          const source = path.join(current.absolute, entry.name);
          if (options.testing === true && typeof options.beforeEntryLstat === "function") await options.beforeEntryLstat(relative, source);
          const info = await lstat(source);
          if (info.isSymbolicLink()) {
            exclusions.push(exclusion(relative, "DENY_LINK"));
            continue;
          }
          if (info.isDirectory()) {
            const rule = directoryDenyRule(relative);
            if (rule) exclusions.push(exclusion(relative, rule));
            else {
              const childIdentity = await canonicalDirectory(source);
              if (!childIdentity || childIdentity.dev !== info.dev || childIdentity.ino !== info.ino) fail("BACKUP_DIRECTORY_CHANGED");
              stack.push({ absolute: source, relative, depth: current.depth + 1, expected: childIdentity });
            }
            continue;
          }
          if (!info.isFile()) {
            exclusions.push(exclusion(relative, "DENY_NON_REGULAR"));
            continue;
          }
          const deny = fileDenyRule(relative);
          if (deny) {
            exclusions.push(exclusion(relative, deny));
            continue;
          }
          if (info.size > limits.maxFileBytes) fail("BACKUP_FILE_QUOTA_EXCEEDED");
          if (totalBytes + info.size > limits.maxTotalBytes) fail("BACKUP_TOTAL_QUOTA_EXCEEDED");
          await freeSpaceCheck(context.rootIdentity.path, info.size);
          const copied = await copySafeFile(source, path.join(filesRoot, ...relative.split("/")), relative, workspace, info, {
            ...options, transaction, limits, filesRoot, createdDirectories,
          }, heartbeat);
          if (copied.excluded) {
            for (const rule of copied.excluded) exclusions.push(exclusion(relative, rule));
            continue;
          }
          if (relative === "HANDOFF.md") {
            if (!equalHash(copied.sha256, input.documentSha256)) fail("DOCUMENT_HASH_MISMATCH");
            handoffDigest = copied.sha256;
          }
          totalBytes += copied.bytes;
          files.push({ path: relative, bytes: copied.bytes, sha256: copied.sha256, type: copied.type });
        }
      } finally {
        await directory.close().catch(() => {});
      }
      await assertDirectoryIdentity(current.absolute, directoryIdentity);
    }
    if (!equalHash(handoffDigest, input.documentSha256)) fail("DOCUMENT_HASH_MISMATCH");
    await assertDirectoryIdentity(context.rootIdentity.path, context.rootIdentity, "BACKUP_ROOT_CHANGED");
    await assertDirectoryIdentity(projectDirectory, projectIdentity, "BACKUP_ROOT_CHANGED");
    files.sort((left, right) => left.path.localeCompare(right.path, "en"));
    exclusions.sort((left, right) => left.path_digest.localeCompare(right.path_digest, "en") || left.rule_id.localeCompare(right.rule_id, "en"));
    const directories = [...createdDirectories].sort((left, right) => left.localeCompare(right, "en"));
    finalSnapshot = path.join(projectDirectory, snapshotName);
    if (!safeAbsolutePath(finalSnapshot) || await lstat(finalSnapshot).catch(() => null)) fail("BACKUP_DESTINATION_EXISTS");
    const docs = documentationText({
      purpose: input.purpose, projectLabel: safeProjectLabel(path.basename(workspace)), workspace,
      snapshot: finalSnapshot, files, exclusions, documentSha256: input.documentSha256,
    });
    if (metadataRules(docs, options).length) fail("BACKUP_METADATA_UNSAFE");
    await writeExclusive(path.join(partial, DOCUMENTATION_FILE), docs);
    const documentationHash = hashBytes(Buffer.from(docs, "utf8"));
    const manifest = {
      version: 2, created_at: created.toISOString(), created_at_china: chineseTimestamp(created),
      root_id: context.marker.root_id, project_label: safeProjectLabel(path.basename(workspace)),
      source_workspace: workspace, backup_snapshot: finalSnapshot,
      project_files: path.join(finalSnapshot, FILES_DIRECTORY), mode: automatic ? "automatic" : "manual",
      snapshot_id: stableId, idempotency_key: idempotencyKey, document_sha256: input.documentSha256,
      documentation_sha256: documentationHash, receipt_file: RECEIPT_FILE,
      limits: { max_files: limits.maxFiles, max_total_bytes: limits.maxTotalBytes, max_file_bytes: limits.maxFileBytes, max_depth: limits.maxDepth, max_relative_path: limits.maxRelativePath },
      totals: { files: files.length, bytes: totalBytes, exclusions: exclusions.length }, directories, files, exclusions,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
    if (metadataRules(manifestBytes.toString("utf8"), options).length) fail("BACKUP_METADATA_UNSAFE");
    await writeExclusive(path.join(partial, MANIFEST_FILE), manifestBytes);
    const manifestHash = hashBytes(manifestBytes);
    const checksumEntries = files.map((item) => ({ path: `${FILES_DIRECTORY}/${item.path}`, sha256: item.sha256 }));
    checksumEntries.push({ path: DOCUMENTATION_FILE, sha256: documentationHash }, { path: MANIFEST_FILE, sha256: manifestHash });
    checksumEntries.sort((left, right) => left.path.localeCompare(right.path, "en"));
    const checksumBytes = Buffer.from(checksumEntries.map((item) => `${item.sha256}  ${item.path}`).join("\n") + "\n", "utf8");
    await writeExclusive(path.join(partial, CHECKSUM_FILE), checksumBytes);
    const checksumHash = hashBytes(checksumBytes);
    await assertRootMarkerProof(context);
    const signedReceipt = {
      version: 1, root_id: context.marker.root_id, document_sha256: input.documentSha256,
      snapshot_id: stableId, idempotency_key: idempotencyKey, manifest_sha256: manifestHash,
      checksum_sha256: checksumHash,
    };
    signedReceipt.signature = receiptSignature(signedReceipt, context.marker.auth_key);
    await writeExclusive(path.join(partial, RECEIPT_FILE), JSON.stringify(signedReceipt, null, 2) + "\n");
    const receipt = returnedReceipt(finalSnapshot, signedReceipt);
    await unlink(path.join(partial, OWNER_FILE));
    await syncDirectory(partial);
    await verifySnapshotTree(partial, receipt, expected, context, options);
    if (options.testing === true && options.injectFailure === "before_publish") fail("BACKUP_INJECTED_FAILURE");
    if (options.testing === true && options.injectFailure === "simulated_crash") fail("BACKUP_SIMULATED_CRASH");
    await assertDirectoryIdentity(context.rootIdentity.path, context.rootIdentity, "BACKUP_ROOT_CHANGED");
    await assertDirectoryIdentity(projectDirectory, projectIdentity, "BACKUP_ROOT_CHANGED");
    if (options.testing === true && options.injectFailure === "rename") fail("BACKUP_RENAME_FAILED");
    if (options.testing === true && typeof options.beforePublicationMarkerCheck === "function") await options.beforePublicationMarkerCheck(context.markerProof.path);
    await assertRootMarkerProof(context);
    await rename(partial, finalSnapshot);
    published = true;
    partial = null;
    await syncDirectory(projectDirectory);
    if (options.testing === true && typeof options.afterPublication === "function") await options.afterPublication(finalSnapshot, context.markerProof.path);
    const postPublication = await verifyBackupReceipt(receipt, expected, options);
    if (!postPublication.ok) fail("BACKUP_POST_PUBLICATION_VERIFY_FAILED");
    await unlink(sidecar);
    sidecar = null;
    await releaseBackupLock(lock, projectDirectory, projectIdentity).catch(() => false);
    lock = null;
    return { ok: true, ...receipt, reused: false };
  } catch (error) {
    if (error instanceof BackupError && error.code === "BACKUP_SIMULATED_CRASH" && options.testing === true) {
      return { ok: false, error: error.code };
    }
    if (published && finalSnapshot && sidecar && lock && projectDirectory && projectIdentity && context) {
      try {
        if (options.testing === true && options.injectCleanupFailure === true) throw new Error("injected cleanup failure");
        const receiptRead = (await readRegularJson(path.join(finalSnapshot, RECEIPT_FILE), 64 * 1024)).value;
        const receipt = returnedReceipt(finalSnapshot, receiptRead);
        const expected = { workspaceRoot: context.workspaceIdentity.path, documentSha256: input.documentSha256, idempotencyKey: receipt.backup_idempotency_key };
        await retractOwnedPublished(context, projectDirectory, projectIdentity, lock, sidecar, finalSnapshot, receipt, expected);
        published = false;
        finalSnapshot = null;
        sidecar = null;
      } catch {
        cleanupFailed = true;
      }
    } else if (!published && partial && sidecar && lock && projectDirectory && projectIdentity) {
      try {
        if (options.testing === true && options.injectCleanupFailure === true) throw new Error("injected cleanup failure");
        await cleanupOwnedPartial(projectDirectory, projectIdentity, lock.value, lock.value.partial_name.slice(-16));
        partial = null;
        sidecar = null;
      } catch {
        cleanupFailed = true;
      }
    }
    if (lock) await releaseBackupLock(lock, projectDirectory, projectIdentity).catch(() => {});
    return { ok: false, error: cleanupFailed ? "BACKUP_CLEANUP_FAILED" : error instanceof BackupError ? error.code : "BACKUP_FAILED" };
  }
}

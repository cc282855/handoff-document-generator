#!/usr/bin/env node

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CONTEXT_THRESHOLD_PERCENT = 98n;
export const DEFAULT_TAIL_BYTES = 4 * 1024 * 1024;
export const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REQUEST_TTL_MS = 30 * 60 * 1000;
export const LOCK_TTL_MS = 30 * 1000;
export const MAX_REQUEST_ATTEMPTS = 2;
export const MAX_STATE_RECORDS = 100;

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const STATE_NAME_RE = /^[a-f0-9]{64}\.json$/;
const CHECKPOINTS = [
  "requested",
  "handoff_written",
  "scan_passed",
  "child_created",
  "title_set",
  "complete",
];

function toPositiveBigInt(value) {
  if (typeof value === "bigint") return value > 0n ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return BigInt(value);
  return null;
}

export function isAtContextThreshold(used, total) {
  const usedValue = toPositiveBigInt(used);
  const totalValue = toPositiveBigInt(total);
  if (usedValue === null || totalValue === null || usedValue > totalValue) return false;
  return usedValue * 100n >= totalValue * CONTEXT_THRESHOLD_PERCENT;
}

function parseTokenAmount(value, unit) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  const multiplier = !unit ? 1 : unit.toLowerCase() === "k" ? 1_000 : 1_000_000;
  return Math.round(number * multiplier);
}

export function parseUiContextStatus(text) {
  if (typeof text !== "string" || text.length > 64 * 1024) return null;
  const normalized = text.replace(/，/g, ",").replace(/[（）]/g, function (char) {
    return char === "（" ? "(" : ")";
  });
  let usedPercent = null;
  let remainingPercent = null;
  let match = normalized.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:已用|used\b)/iu);
  if (match) usedPercent = Number(match[1]);
  match = normalized.match(/(?:剩余|remaining)\s*(\d{1,3}(?:\.\d+)?)\s*%/iu);
  if (!match) match = normalized.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:剩余|remaining\b)/iu);
  if (match) remainingPercent = Number(match[1]);
  let usedTokens = null;
  let totalTokens = null;
  match = normalized.match(/(?:已用|used)\s*(\d+(?:\.\d+)?)\s*([km]?)\s*(?:标记|tokens?)/iu);
  if (!match) {
    match = normalized.match(/(\d+(?:\.\d+)?)\s*([km]?)\s*(?:标记|tokens?)\s*(?:已用|used)/iu);
  }
  if (match) usedTokens = parseTokenAmount(match[1], match[2]);
  match = normalized.match(/(?:共|total(?:\s+of)?|of)\s*(\d+(?:\.\d+)?)\s*([km]?)\s*(?:标记|tokens?)?/iu);
  if (!match) {
    match = normalized.match(/(\d+(?:\.\d+)?)\s*([km]?)\s*(?:标记|tokens?)?\s*(?:总计|total)/iu);
  }
  if (match) totalTokens = parseTokenAmount(match[1], match[2]);
  if (usedPercent === null && remainingPercent !== null) usedPercent = 100 - remainingPercent;
  if (remainingPercent === null && usedPercent !== null) remainingPercent = 100 - usedPercent;
  if (
    usedPercent === null ||
    usedPercent < 0 ||
    usedPercent > 100 ||
    remainingPercent === null ||
    remainingPercent < 0 ||
    remainingPercent > 100
  ) {
    return null;
  }
  return {
    source: "explicit_ui_text",
    usedPercent,
    remainingPercent,
    usedTokens,
    totalTokens,
  };
}

export function extractLatestStructuredUsage(text) {
  if (typeof text !== "string") return null;
  let latest = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type !== "event_msg" || event?.payload?.type !== "token_count") continue;
      const used = toPositiveBigInt(event?.payload?.info?.last_token_usage?.input_tokens);
      const total = toPositiveBigInt(event?.payload?.info?.model_context_window);
      if (used === null || total === null || used > total) continue;
      latest = { used: Number(used), total: Number(total), source: "rollout_token_count" };
    } catch {
      // A live JSONL file can end with a partially written record.
    }
  }
  return latest;
}

export async function readTailText(filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  const file = await open(filePath, "r");
  try {
    const info = await file.stat();
    const length = Math.min(info.size, maxBytes);
    const start = info.size - length;
    const buffer = Buffer.alloc(length);
    if (length) await file.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    return text;
  } finally {
    await file.close();
  }
}

async function readFirstText(filePath, maxBytes = 1024 * 1024) {
  const file = await open(filePath, "r");
  try {
    const info = await file.stat();
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length) await file.read(buffer, 0, length, 0);
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function findSessionHeaderId(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "session_meta" && typeof event?.payload?.id === "string") {
        return event.payload.id;
      }
    } catch {
      // Ignore malformed records while searching for the required header.
    }
  }
  return null;
}

export async function validateTranscriptPath({ transcriptPath, sessionId, codexHome }) {
  if (!SESSION_ID_RE.test(sessionId || "")) return null;
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) return null;
  if (typeof codexHome !== "string" || !path.isAbsolute(codexHome)) return null;
  const sessionsInput = path.join(codexHome, "sessions");
  let sessionsRoot;
  let transcriptReal;
  try {
    const linkInfo = await lstat(transcriptPath);
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) return null;
    sessionsRoot = await realpath(sessionsInput);
    transcriptReal = await realpath(transcriptPath);
    const transcriptInfo = await stat(transcriptReal);
    if (!transcriptInfo.isFile() || !isInside(sessionsRoot, transcriptReal)) return null;
  } catch {
    return null;
  }
  const expectedSuffix = "-" + sessionId + ".jsonl";
  if (!path.basename(transcriptReal).endsWith(expectedSuffix)) return null;
  const headerId = findSessionHeaderId(await readFirstText(transcriptReal));
  if (headerId !== sessionId) return null;
  return transcriptReal;
}

export function normalizeTaskTitle(title, maxLength = 96) {
  let value = typeof title === "string" ? title : "";
  value = value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) value = "未命名任务";
  return Array.from(value).slice(0, maxLength).join("");
}

function splitContinuationTitle(title) {
  const normalized = normalizeTaskTitle(title);
  const match = normalized.match(/^(.*?)(?:（续接\s+(\d+)）)$/u);
  if (!match) return { base: normalized, sequence: 0 };
  return {
    base: normalizeTaskTitle(match[1]),
    sequence: Number.parseInt(match[2], 10) || 0,
  };
}

export function nextContinuationTitle(currentTitle, existingTitles = [], maxLength = 96) {
  const current = splitContinuationTitle(currentTitle);
  let highest = current.sequence;
  for (const candidate of existingTitles) {
    const parsed = splitContinuationTitle(candidate);
    if (parsed.base === current.base) highest = Math.max(highest, parsed.sequence);
  }
  const suffix = "（续接 " + (highest + 1) + "）";
  const baseLimit = Math.max(1, maxLength - Array.from(suffix).length);
  const base = Array.from(current.base).slice(0, baseLimit).join("");
  return base + suffix;
}

function looksLikePlaceholder(value) {
  const normalized = value.replace(/^["']|["']$/g, "").trim().toLowerCase();
  return (
    !normalized ||
    /^(?:redacted|masked|unknown|unset|none|null|example|placeholder|not[_ -]?set|\*+)$/.test(normalized) ||
    /^<[^>]+>$/.test(normalized) ||
    /^\$\{[^}]+\}$/.test(normalized)
  );
}

export function scanSecrets(text) {
  if (typeof text !== "string") return [];
  const findings = [];
  const seen = new Set();
  function add(ruleId, line) {
    const key = ruleId + ":" + line;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ ruleId, line });
    }
  }
  const lines = text.split(/\r?\n/);
  lines.forEach(function (line, index) {
    const lineNumber = index + 1;
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(line)) {
      add("PRIVATE_KEY", lineNumber);
    }
    if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/.test(line)) {
      add("TOKEN_PREFIX", lineNumber);
    }
    if (/\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@[^/\s]+/iu.test(line)) {
      add("URL_USERINFO", lineNumber);
    }
    if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(line)) {
      add("JWT", lineNumber);
    }
    const assignment = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\s*[:=]\s*(.+?)\s*$/i);
    if (assignment && !looksLikePlaceholder(assignment[2]) && assignment[2].replace(/^["']|["']$/g, "").length >= 8) {
      add("ENV_SECRET_ASSIGNMENT", lineNumber);
    }
  });
  return findings;
}

function sessionHash(sessionId) {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

function hashValue(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function statePaths(pluginData, hash) {
  const directory = path.join(path.resolve(pluginData), "context-handoff-v1");
  return {
    directory,
    file: path.join(directory, hash + ".json"),
    lock: path.join(directory, hash + ".lock"),
  };
}

async function readState(file, expectedHash) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value?.version !== 1 || value?.session_hash !== expectedHash) return null;
    return value;
  } catch {
    return null;
  }
}

async function writeState(file, value) {
  const temporary = file + "." + randomBytes(8).toString("hex") + ".tmp";
  await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function acquireLock(lockPath, now) {
  try {
    await mkdir(lockPath);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") return false;
  }
  try {
    const info = await stat(lockPath);
    if (now - info.mtimeMs <= LOCK_TTL_MS) return false;
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function withSessionLock(paths, now, action) {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  if (!(await acquireLock(paths.lock, now))) return { acquired: false, value: null };
  try {
    return { acquired: true, value: await action() };
  } finally {
    await rm(paths.lock, { recursive: true, force: true });
  }
}

export async function cleanupPluginState(pluginData, now = Date.now()) {
  const directory = path.join(path.resolve(pluginData), "context-handoff-v1");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const records = [];
  for (const entry of entries) {
    const itemPath = path.join(directory, entry.name);
    if (entry.isDirectory() && /^[a-f0-9]{64}\.lock$/.test(entry.name)) {
      try {
        const info = await stat(itemPath);
        if (now - info.mtimeMs > LOCK_TTL_MS) await rm(itemPath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
      continue;
    }
    if (!entry.isFile() || !STATE_NAME_RE.test(entry.name)) continue;
    try {
      const info = await stat(itemPath);
      let retired = info.mtimeMs + STATE_TTL_MS;
      try {
        const parsed = JSON.parse(await readFile(itemPath, "utf8"));
        if (Number.isFinite(parsed?.retire_at)) retired = parsed.retire_at;
      } catch {
        // Malformed state is removed by age and never trusted.
      }
      if (retired <= now) {
        await rm(itemPath, { force: true });
      } else {
        records.push({ itemPath, mtimeMs: info.mtimeMs });
      }
    } catch {
      // Ignore races.
    }
  }
  records.sort(function (a, b) {
    return b.mtimeMs - a.mtimeMs;
  });
  for (const extra of records.slice(MAX_STATE_RECORDS)) await rm(extra.itemPath, { force: true });
}

function createBaseState(hash, now) {
  return {
    version: 1,
    session_hash: hash,
    updated_at: now,
    expires_at: now + REQUEST_TTL_MS,
    retire_at: now + STATE_TTL_MS,
    request_attempts: 0,
    precompact_seen: 0,
  };
}

function createRequestedState(existing, hash, trigger, now) {
  const attempts = (existing?.request_attempts || 0) + 1;
  if (attempts > MAX_REQUEST_ATTEMPTS) return null;
  return {
    ...createBaseState(hash, now),
    precompact_seen: existing?.precompact_seen || 0,
    state: "requested",
    trigger,
    nonce: randomBytes(18).toString("base64url"),
    request_attempts: attempts,
  };
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function stopDecision(sessionId, state, usage) {
  const used = usage ? String(usage.used) : "unknown";
  const total = usage ? String(usage.total) : "unknown";
  const reason =
    "AUTO_HANDOFF_REQUEST session_id=" +
    sessionId +
    " nonce=" +
    state.nonce +
    " trigger=" +
    state.trigger +
    " used=" +
    used +
    " window=" +
    total +
    ". Invoke generate-handoff-document automatic flow now.";
  return { decision: "block", reason };
}

export async function handleHookEvent(input, options = {}) {
  if (!input || typeof input !== "object") return null;
  if (input.hook_event_name === "Stop" && input.stop_hook_active === true) return null;
  if (input.hook_event_name !== "Stop" && input.hook_event_name !== "PreCompact") return null;
  const codexHome = options.codexHome ?? process.env.CODEX_HOME;
  const pluginData = options.pluginData ?? process.env.PLUGIN_DATA;
  if (!codexHome || !pluginData) return null;
  const sessionId = input.session_id;
  const transcript = await validateTranscriptPath({
    transcriptPath: input.transcript_path,
    sessionId,
    codexHome,
  });
  if (!transcript) return null;
  let usage = null;
  if (input.hook_event_name === "Stop") {
    usage = extractLatestStructuredUsage(await readTailText(transcript));
  }
  const hash = sessionHash(sessionId);
  const paths = statePaths(pluginData, hash);
  const now = options.now ?? Date.now();
  try {
    await cleanupPluginState(pluginData, now);
    const locked = await withSessionLock(paths, now, async function () {
      const existing = await readState(paths.file, hash);
      if (input.hook_event_name === "PreCompact") {
        if (existing) return null;
        const pending = {
          ...createBaseState(hash, now),
          state: "pending_precompact",
          trigger: "precompact",
          precompact_seen: 1,
        };
        await writeState(paths.file, pending);
        return { continue: false };
      }
      if (existing?.state === "pending_precompact") {
        const requested = createRequestedState(existing, hash, "precompact", now);
        if (!requested) return null;
        await writeState(paths.file, requested);
        return stopDecision(sessionId, requested, usage);
      }
      if (existing?.state === "requested") {
        if (existing.expires_at > now || existing.request_attempts >= MAX_REQUEST_ATTEMPTS) return null;
        const requested = createRequestedState(existing, hash, existing.trigger, now);
        if (!requested) return null;
        await writeState(paths.file, requested);
        return stopDecision(sessionId, requested, usage);
      }
      if (existing) return null;
      if (!usage || !isAtContextThreshold(usage.used, usage.total)) return null;
      const requested = createRequestedState(null, hash, "exact_98", now);
      await writeState(paths.file, requested);
      return stopDecision(sessionId, requested, usage);
    });
    return locked.acquired ? locked.value : null;
  } catch {
    return null;
  }
}

export async function checkpointState(input, options = {}) {
  const pluginData = options.pluginData ?? process.env.PLUGIN_DATA;
  const sessionId = input?.session_id;
  const desired = input?.next_state;
  if (!pluginData || !SESSION_ID_RE.test(sessionId || "") || !CHECKPOINTS.includes(desired)) {
    return { ok: false, error: "INVALID_CHECKPOINT" };
  }
  const hash = sessionHash(sessionId);
  const paths = statePaths(pluginData, hash);
  const now = options.now ?? Date.now();
  try {
    const locked = await withSessionLock(paths, now, async function () {
      const current = await readState(paths.file, hash);
      if (!current || !safeEqual(current.nonce, input.nonce)) {
        return { ok: false, error: "CHECKPOINT_NOT_FOUND" };
      }
      const currentIndex = CHECKPOINTS.indexOf(current.state);
      const desiredIndex = CHECKPOINTS.indexOf(desired);
      if (current.state === desired) {
        if (
          desired === "child_created" &&
          current.child_id_hash &&
          typeof input.child_id === "string" &&
          current.child_id_hash !== hashValue(input.child_id)
        ) {
          return { ok: false, error: "CHILD_ALREADY_RECORDED" };
        }
        return { ok: true, state: current.state };
      }
      if (desiredIndex !== currentIndex + 1) return { ok: false, error: "INVALID_TRANSITION" };
      const next = {
        ...current,
        state: desired,
        updated_at: now,
        expires_at: now + REQUEST_TTL_MS,
        retire_at: now + STATE_TTL_MS,
      };
      if (desired === "child_created") {
        if (typeof input.child_id !== "string" || !input.child_id) {
          return { ok: false, error: "CHILD_ID_REQUIRED" };
        }
        next.child_id_hash = hashValue(input.child_id);
      }
      if (desired === "complete") next.expires_at = next.retire_at;
      await writeState(paths.file, next);
      return { ok: true, state: next.state };
    });
    return locked.acquired ? locked.value : { ok: false, error: "STATE_BUSY" };
  } catch {
    return { ok: false, error: "CHECKPOINT_FAILED" };
  }
}

async function readStdin(limit = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > limit) throw new Error("STDIN_LIMIT");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runCli() {
  const command = process.argv[2];
  if (command === "hook") {
    try {
      const input = JSON.parse(await readStdin());
      const output = await handleHookEvent(input);
      if (output) process.stdout.write(JSON.stringify(output));
    } catch {
      // Hook failures are deliberately fail-open and silent.
    }
    return;
  }
  if (command === "checkpoint") {
    try {
      const input = JSON.parse(await readStdin());
      const output = await checkpointState(input);
      process.stdout.write(JSON.stringify(output));
      if (!output.ok) process.exitCode = 1;
    } catch {
      process.stdout.write(JSON.stringify({ ok: false, error: "INVALID_CHECKPOINT" }));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "scan") {
    try {
      const target = process.argv[3];
      if (!target || !path.isAbsolute(target)) throw new Error("INVALID_SCAN_TARGET");
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) {
        throw new Error("INVALID_SCAN_TARGET");
      }
      const findings = scanSecrets(await readFile(target, "utf8"));
      process.stdout.write(JSON.stringify({ ok: findings.length === 0, findings }));
      if (findings.length) process.exitCode = 2;
    } catch {
      process.stdout.write(JSON.stringify({ ok: false, error: "SCAN_FAILED", findings: [] }));
      process.exitCode = 3;
    }
    return;
  }
  if (command === "parse-ui") {
    try {
      process.stdout.write(JSON.stringify(parseUiContextStatus(await readStdin(64 * 1024))));
    } catch {
      process.exitCode = 1;
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await runCli();

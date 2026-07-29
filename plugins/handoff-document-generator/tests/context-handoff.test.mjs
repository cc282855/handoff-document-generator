import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  LOCK_TTL_MS,
  LEASE_TTL_MS,
  acquireLock,
  backupAuthorized,
  backupManualRequest,
  buildChildPrompt,
  checkpointState,
  claimRequest,
  cleanupBrokerState,
  cleanupPluginState,
  contextGuardTokens,
  deriveBrokerHome,
  deriveCodexHome,
  extractLatestStructuredUsage,
  handleHookEvent,
  isAtContextGuard,
  nextContinuationTitle,
  normalizeTaskTitle,
  parseRequestMarker,
  parseUiContextStatus,
  readTailText,
  releaseLock,
  resolveLocalProjectTarget,
  scanFile,
  scanFileAuthorized,
  scanManualRequest,
  scanSecrets,
  validateTranscriptPath,
} from "../scripts/context-handoff.mjs";
import {
  BACKUP_MAX_FILE_BYTES,
  createProjectBackup,
  resolveBackupRoot,
  verifyBackupReceipt,
} from "../scripts/project-backup.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = path.join(projectRoot, "work");
const fixtureRoot = new URL("./fixtures/", import.meta.url);
const syntheticTaskTarget = Object.freeze({
  project_id: "local-test-project",
  child_title: "测试任务（续接 1）",
});

function jsonLine(value) {
  return JSON.stringify(value);
}

function sessionMeta(id) {
  return jsonLine({ type: "session_meta", payload: { id } });
}

function tokenEvent(inputTokens, window, totalTokens = inputTokens) {
  return jsonLine({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        model_context_window: window,
        last_token_usage: {
          input_tokens: inputTokens,
          total_tokens: totalTokens,
        },
        total_token_usage: { input_tokens: 999_999_999 },
      },
    },
  });
}

function compactedEvent() {
  return jsonLine({ type: "event_msg", payload: { type: "context_compacted" } });
}

async function fixtureSession(t, body, id = "11111111-2222-4333-8444-555555555555") {
  await mkdir(workRoot, { recursive: true });
  const base = await mkdtemp(path.join(workRoot, "test-hook-"));
  t.after(async function () {
    await rm(base, { recursive: true, force: true });
  });
  const codexHome = path.join(base, "codex");
  const pluginData = path.join(base, "plugin-data");
  const day = path.join(codexHome, "sessions", "2026", "07", "14");
  await mkdir(day, { recursive: true });
  await mkdir(pluginData, { recursive: true });
  const transcript = path.join(day, "rollout-synthetic-" + id + ".jsonl");
  await writeFile(transcript, sessionMeta(id) + "\n" + body + "\n");
  return { base, codexHome, pluginData, transcript, id };
}

function fixtureBackupOptions(t, f, now = new Date("2026-07-28T08:00:00.000Z")) {
  const root = path.join(path.dirname(f.base), "backup-" + path.basename(f.base));
  t.after(async function () { await rm(root, { recursive: true, force: true }); });
  return { ...f, now: now instanceof Date ? now.getTime() : now, env: { CODEX_HANDOFF_BACKUP_ROOT: root } };
}

async function backupWorkspace(t, label = "项目") {
  await mkdir(workRoot, { recursive: true });
  const parent = await mkdtemp(path.join(workRoot, "test-backup-parent-"));
  const workspace = path.join(parent, label);
  const backupRoot = path.join(parent, "safe-backups");
  await mkdir(workspace, { recursive: true });
  const document = path.join(workspace, "HANDOFF.md");
  await writeFile(document, "# HANDOFF\n\n## PROJECT OVERVIEW\n\n安全的项目备份用途。\n");
  const documentSha256 = createHash("sha256").update(await readFile(document)).digest("hex");
  t.after(async function () { await rm(parent, { recursive: true, force: true }); });
  return {
    parent,
    workspace,
    backupRoot,
    document,
    documentSha256,
    options: {
      env: { CODEX_HANDOFF_BACKUP_ROOT: backupRoot },
      now: new Date("2026-07-28T08:09:10.000Z"),
      scanText(text) { return [...new Set(scanSecrets(text).map(function (item) { return item.ruleId; }))]; },
      scanCapabilityBytes() { return []; },
    },
  };
}

function hookInput(f, eventName, extra = {}) {
  return {
    hook_event_name: eventName,
    session_id: f.id,
    transcript_path: f.transcript,
    cwd: f.base,
    ...extra,
  };
}

function markerFromResult(result) {
  const text = result?.reason || result?.hookSpecificOutput?.additionalContext || "";
  return parseRequestMarker(text);
}

async function windowsShortPath(value) {
  if (process.platform !== "win32") return null;
  const helper = path.join(value, ".get-short-path.cmd");
  await writeFile(helper, "@chcp 65001 >nul\r\n@echo %~s1\r\n");
  try {
    const result = await execFile("cmd.exe", ["/d", "/c", helper, value]);
    return result.stdout.trim() || null;
  } finally {
    await rm(helper, { force: true });
  }
}

test("70 percent policy includes native-limit headroom", function () {
  assert.equal(contextGuardTokens(258400), 179792n);
  assert.equal(isAtContextGuard(179791, 258400), false);
  assert.equal(isAtContextGuard(179792, 258400), true);
  assert.equal(isAtContextGuard(136000, 258400), false);
  assert.equal(contextGuardTokens(50000), 0n);
  assert.equal(isAtContextGuard(0, 50000), true);
});

test("structured usage follows reset and post-compaction growth", function () {
  const body = [
    tokenEvent(220326, 258400, 220433),
    tokenEvent(0, 258400, 0),
    jsonLine({ type: "compacted", payload: { replacement_history: [] } }),
    compactedEvent(),
    tokenEvent(136000, 258400, 136200),
    "{partial",
  ].join("\n");
  assert.deepEqual(extractLatestStructuredUsage(body), {
    used: 136200,
    total: 258400,
    source: "rollout_token_count",
  });
  assert.equal(extractLatestStructuredUsage([
    tokenEvent(220326, 258400),
    compactedEvent(),
  ].join("\n")), null);
  assert.deepEqual(extractLatestStructuredUsage(tokenEvent(258000, 258400, 260000)), {
    used: 258400,
    total: 258400,
    source: "rollout_token_count",
  });
  assert.deepEqual(extractLatestStructuredUsage(tokenEvent(100, 258400, 50)), {
    used: 50,
    total: 258400,
    source: "rollout_token_count",
  });
});

test("checked-in synthetic rollout mirrors the observed compact-reset sequence", async function () {
  const rollout = await readFile(new URL("rollout.synthetic.txt", fixtureRoot), "utf8");
  assert.match(rollout, /\"type\":\"compacted\"/);
  assert.match(rollout, /\"input_tokens\":0,\"total_tokens\":20082/);
  assert.match(rollout, /\"type\":\"context_compacted\"/);
  assert.deepEqual(extractLatestStructuredUsage(rollout), {
    used: 136200,
    total: 258400,
    source: "rollout_token_count",
  });
});

test("UI parser is diagnostic, NFKC aware, comma aware, and conflict rejecting", function () {
  assert.deepEqual(parseUiContextStatus("背景信息窗口：\n５２% 已用（剩余 ４８%）\n已用 136,000 标记，共 258,400"), {
    source: "explicit_ui_text_diagnostic_only",
    usedPercent: 52,
    remainingPercent: 48,
    usedTokens: 136000,
    totalTokens: 258400,
  });
  const english = parseUiContextStatus("Context: 48% remaining; 136k tokens used, total 258.4k tokens");
  assert.equal(english.usedPercent, 52);
  assert.equal(english.usedTokens, 136000);
  assert.equal(english.totalTokens, 258400);
  assert.equal(parseUiContextStatus("52% used, 70% remaining; 136k tokens used, total 258.4k"), null);
  assert.equal(parseUiContextStatus("52% used, 48% remaining; 220k tokens used, total 258.4k"), null);
});

test("transcript validation derives CODEX_HOME and rejects mismatches", async function (t) {
  const f = await fixtureSession(t, tokenEvent(1, 258400));
  assert.equal(deriveCodexHome(f.transcript), f.codexHome);
  assert.equal(await validateTranscriptPath({
    transcriptPath: f.transcript,
    sessionId: f.id,
  }), await realpath(f.transcript));
  assert.equal(await validateTranscriptPath({
    transcriptPath: f.transcript,
    sessionId: "different-session-id",
    codexHome: f.codexHome,
  }), null);
  const outside = path.join(f.base, "rollout-synthetic-" + f.id + ".jsonl");
  await writeFile(outside, sessionMeta(f.id));
  assert.equal(await validateTranscriptPath({
    transcriptPath: outside,
    sessionId: f.id,
    codexHome: f.codexHome,
  }), null);
});

test("installed plugin path determines one broker home despite process-home drift", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const installedHome = path.join(f.base, "installed-codex-home");
  const installedModule = path.join(
    installedHome,
    "plugins",
    "cache",
    "handoff-document-generator",
    "handoff-document-generator",
    "0.4.0+test",
    "scripts",
    "context-handoff-core.mjs",
  );
  assert.equal(
    deriveBrokerHome(path.join(f.base, "different-process-home"), installedModule),
    path.resolve(installedHome),
  );
  assert.equal(
    deriveBrokerHome(f.codexHome, path.join(f.base, "source", "plugins", "handoff-document-generator", "scripts", "context-handoff-core.mjs")),
    path.resolve(f.codexHome),
  );
});

test("hook and claim share an explicit broker home when transcript homes differ", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const brokerHome = path.join(f.base, "stable-broker-home");
  await mkdir(brokerHome, { recursive: true });
  const signal = await handleHookEvent(hookInput(f, "Stop"), {
    brokerHome,
    now: 9000,
    testing: true,
  });
  const claim = await claimRequest(markerFromResult(signal), {
    codexHome: path.join(f.base, "different-claim-home"),
    brokerHome,
    now: 9001,
  });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  assert.equal(claim.resume_stage, "claimed");
});

test("local project target requires one exact registered local workspace", async function (t) {
  const f = await fixtureSession(t, tokenEvent(1, 258400));
  const other = path.join(f.base, "other");
  await mkdir(other, { recursive: true });
  const registered = await resolveLocalProjectTarget({
    workspace_root: f.base,
    projects: [
      { projectId: "chatgpt", projectKind: "chatgpt", hostId: null, path: f.base },
      { projectId: "remote", projectKind: "local", hostId: "remote-host", path: f.base },
      { projectId: "other", projectKind: "local", hostId: "local", path: other },
      { projectId: "exact-local", projectKind: "local", hostId: "local", path: f.base },
    ],
  });
  assert.deepEqual(registered, {
    ok: true,
    project_id: "exact-local",
    workspace_root: await realpath(f.base),
    target: {
      type: "project",
      projectId: "exact-local",
      environment: { type: "local" },
    },
  });
  assert.equal((await resolveLocalProjectTarget({
    workspace_root: f.base,
    projects: [{ projectId: "other", projectKind: "local", hostId: "local", path: other }],
  })).error, "PROJECT_NOT_REGISTERED");
  assert.equal((await resolveLocalProjectTarget({
    workspace_root: f.base,
    projects: [
      { projectId: "one", projectKind: "local", hostId: "local", path: f.base },
      { projectId: "two", projectKind: "local", hostId: "local", path: f.base },
    ],
  })).error, "PROJECT_AMBIGUOUS");
});

test("project-target CLI returns only a verified local project target", async function (t) {
  const f = await fixtureSession(t, tokenEvent(1, 258400));
  const script = path.join(projectRoot, "scripts", "context-handoff.mjs");
  const result = spawnSync(process.execPath, [script, "project-target"], {
    cwd: projectRoot,
    input: JSON.stringify({
      workspace_root: f.base,
      projects: [{ projectId: "verified-local", projectKind: "local", hostId: "local", path: f.base }],
    }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    project_id: "verified-local",
    workspace_root: await realpath(f.base),
    target: {
      type: "project",
      projectId: "verified-local",
      environment: { type: "local" },
    },
  });
});

test("transcript symbolic links are explicitly rejected when platform permits creation", async function (t) {
  const f = await fixtureSession(t, tokenEvent(1, 258400));
  const link = path.join(path.dirname(f.transcript), "linked-" + f.id + ".jsonl");
  try {
    await symlink(f.transcript, link, "file");
    assert.equal(await validateTranscriptPath({
      transcriptPath: link,
      sessionId: f.id,
      codexHome: f.codexHome,
    }), null);
  } catch (error) {
    assert.equal(error?.code, "EPERM", "unexpected symlink-test failure");
  }
});

test("PreToolUse denies at most one original tool and marks it not executed", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const first = await handleHookEvent(hookInput(f, "PreToolUse", { tool_name: "Bash" }), f);
  assert.equal(first.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(first.hookSpecificOutput.permissionDecision, "deny");
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /Handoff Document Generator plugin/);
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /not executed/i);
  assert.ok(markerFromResult(first));
  assert.equal(first.hookSpecificOutput.additionalContext.split(/\r?\n/).length, 1);
  assert.equal(await handleHookEvent(hookInput(f, "PreToolUse"), f), null);
  assert.equal(await handleHookEvent(hookInput(f, "Stop"), f), null);
});

test("PostToolUse projects bounded response size but never blocks or replaces output", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179000, 258400));
  const result = await handleHookEvent(hookInput(f, "PostToolUse", {
    tool_response: { content: "x".repeat(3000) },
  }), f);
  assert.equal(result.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.ok(result.hookSpecificOutput.additionalContext);
  assert.equal(Object.hasOwn(result, "decision"), false);
  assert.equal(Object.hasOwn(result.hookSpecificOutput, "updatedMCPToolOutput"), false);
});

test("PostToolUse can use the last safe observation after a huge transcript record hides token_count", async function (t) {
  const f = await fixtureSession(t, tokenEvent(136000, 258400));
  assert.equal(await handleHookEvent(hookInput(f, "PreToolUse"), f), null);
  await writeFile(f.transcript, sessionMeta(f.id) + "\n" + "x".repeat(5 * 1024 * 1024) + "\n");
  const result = await handleHookEvent(hookInput(f, "PostToolUse", {
    tool_response: "y".repeat(196608),
  }), f);
  assert.equal(result.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.ok(markerFromResult(result));
});

test("hook CLI accepts a multi-megabyte PostToolUse payload instead of failing open at 1 MiB", async function (t) {
  const f = await fixtureSession(t, tokenEvent(136000, 258400));
  const script = path.join(projectRoot, "scripts", "context-handoff.mjs");
  const env = { ...process.env, CODEX_HOME: f.codexHome, PLUGIN_DATA: f.pluginData };
  const pre = spawnSync(process.execPath, [script, "hook"], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    input: JSON.stringify(hookInput(f, "PreToolUse", {
      model: "synthetic",
      turn_id: "turn-large",
      tool_name: "Bash",
      tool_use_id: "tool-large",
      tool_input: {},
      permission_mode: "default",
    })),
  });
  assert.equal(pre.status, 0);
  assert.equal(pre.stdout, "");
  const post = spawnSync(process.execPath, [script, "hook"], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    input: JSON.stringify(hookInput(f, "PostToolUse", {
      model: "synthetic",
      turn_id: "turn-large",
      tool_name: "Bash",
      tool_use_id: "tool-large",
      tool_input: {},
      permission_mode: "default",
      tool_response: "z".repeat(2 * 1024 * 1024),
    })),
  });
  assert.equal(post.status, 0);
  assert.ok(markerFromResult(JSON.parse(post.stdout)));
});

test("hook CLI reports parse and runtime failures with one sanitized diagnostic", async function (t) {
  const script = path.join(projectRoot, "scripts", "context-handoff.mjs");
  const malformed = spawnSync(process.execPath, [script, "hook"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: "{",
  });
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stdout, "");
  assert.equal(malformed.stderr, "HANDOFF_HOOK_FAILURE\n");

  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  await writeFile(path.join(f.codexHome, "plugin-data"), "not a directory");
  const runtime = spawnSync(process.execPath, [script, "hook"], {
    cwd: projectRoot,
    env: { ...process.env, CODEX_HOME: f.codexHome },
    encoding: "utf8",
    input: JSON.stringify(hookInput(f, "Stop")),
  });
  assert.equal(runtime.status, 1);
  assert.equal(runtime.stdout, "");
  assert.equal(runtime.stderr, "HANDOFF_HOOK_FAILURE\n");
  assert.equal(runtime.stderr.includes(f.base), false);
  assert.equal(runtime.stderr.includes(f.id), false);
});

test("Stop handles short or tool-free tasks and stop_hook_active always passes", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const result = await handleHookEvent(hookInput(f, "Stop"), f);
  assert.equal(result.decision, "block");
  assert.ok(markerFromResult(result));
  assert.equal(await handleHookEvent(hookInput(f, "Stop", { stop_hook_active: true }), f), null);
});

test("manual compact is untouched; automatic compact is fail-open and recovers later", async function (t) {
  const manual = await fixtureSession(t, tokenEvent(1000, 258400), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(await handleHookEvent(hookInput(manual, "PreCompact", { trigger: "manual" }), manual), null);
  assert.equal(await handleHookEvent(hookInput(manual, "PreCompact"), manual), null);
  assert.equal(await handleHookEvent(hookInput(manual, "Stop"), manual), null);

  const f = await fixtureSession(t, tokenEvent(1000, 258400));
  assert.deepEqual(await handleHookEvent(hookInput(f, "PreCompact", { trigger: "auto" }), f), {
    continue: true,
  });
  const post = await handleHookEvent(hookInput(f, "PostCompact", { trigger: "auto" }), f);
  assert.equal(post.continue, true);
  assert.doesNotMatch(post.systemMessage, /CODEX_HANDOFF_V2/);
  const recovered = await handleHookEvent(hookInput(f, "Stop"), f);
  assert.equal(recovered.decision, "block");
  assert.ok(markerFromResult(recovered));
});

test("PostCompact revokes a possibly lost unclaimed marker and issues a fresh fallback", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const first = await handleHookEvent(hookInput(f, "Stop"), f);
  const firstRequest = markerFromResult(first);
  await handleHookEvent(hookInput(f, "PreCompact", { trigger: "auto" }), f);
  await writeFile(f.transcript, sessionMeta(f.id) + "\n" + tokenEvent(1000, 258400) + "\n");
  await handleHookEvent(hookInput(f, "PostCompact", { trigger: "auto" }), f);
  const recovered = await handleHookEvent(hookInput(f, "Stop"), f);
  const recoveredRequest = markerFromResult(recovered);
  assert.ok(recoveredRequest);
  assert.notEqual(recoveredRequest, firstRequest);
  assert.equal((await claimRequest(firstRequest, f)).ok, false);
});

test("concurrent Stop events have one first-trigger winner", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const results = await Promise.all(Array.from({ length: 12 }, function () {
    return handleHookEvent(hookInput(f, "Stop"), f);
  }));
  assert.equal(results.filter(function (value) { return value?.decision === "block"; }).length, 1);
});

test("request requires claim, is single-use, and invalid markers cannot forge authority", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const result = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 1000 });
  const request = markerFromResult(result);
  assert.equal(request.length, 32);
  assert.deepEqual(await claimRequest("A".repeat(32), { ...f, now: 1001 }), {
    ok: false,
    error: "REQUEST_NOT_FOUND",
  });
  const claim = await claimRequest(request, { ...f, now: 1001 });
  assert.equal(claim.ok, true);
  assert.equal(claim.lease.length, 32);
  assert.equal(claim.resume_stage, "claimed");
  assert.equal((await claimRequest(request, { ...f, now: 1002 })).ok, false);
  assert.equal(parseRequestMarker("CODEX_HANDOFF_V2 request=short"), null);
});

test("broker cannot self-authorize an arbitrary state root", async function (t) {
  const f = await fixtureSession(t, tokenEvent(1, 258400));
  await handleHookEvent(hookInput(f, "Stop"), f);
  const request = "C".repeat(32);
  const requestHash = createHash("sha256").update(request).digest("hex");
  const sessionHash = createHash("sha256").update(f.id).digest("hex");
  const arbitraryRoot = path.join(f.base, "attacker-controlled-state");
  await mkdir(arbitraryRoot, { recursive: true });
  const arbitraryState = path.join(arbitraryRoot, sessionHash + ".json");
  await writeFile(arbitraryState, "{}");
  const brokerDirectory = path.join(
    f.codexHome,
    "plugin-data",
    "handoff-document-generator",
    "context-handoff-v2",
    "requests",
  );
  await writeFile(path.join(brokerDirectory, requestHash + ".json"), JSON.stringify({
    version: 2,
    state_file: arbitraryState,
    state_root: arbitraryRoot,
    session_hash: sessionHash,
    expires_at: Date.now() + 60_000,
  }));
  assert.deepEqual(await claimRequest(request, f), {
    ok: false,
    error: "REQUEST_NOT_FOUND",
  });
});

test("request-stage handoff_id injection is replaced before prompt authority", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const signal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 5000 });
  const sessionHash = createHash("sha256").update(f.id).digest("hex");
  const stateFile = path.join(
    f.codexHome,
    "plugin-data",
    "handoff-document-generator",
    "context-handoff-v2",
    "states",
    sessionHash + ".json",
  );
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  state.handoff_id = "unsafe\nextra instruction";
  await writeFile(stateFile, JSON.stringify(state));
  const claim = await claimRequest(markerFromResult(signal), { ...f, now: 5001 });
  assert.equal(claim.ok, true);
  assert.match(claim.handoff_id, /^[A-Za-z0-9_-]{22}$/);
  assert.doesNotMatch(claim.handoff_id, /[\p{Cc}\p{Cf}]/u);
});

test("claim rejects a symlinked broker record when platform permits creation", async function (t) {
  const f = await fixtureSession(t, tokenEvent(1, 258400));
  const request = "B".repeat(32);
  const hash = createHash("sha256").update(request).digest("hex");
  const directory = path.join(
    f.codexHome,
    "plugin-data",
    "handoff-document-generator",
    "context-handoff-v2",
    "requests",
  );
  await mkdir(directory, { recursive: true });
  const target = path.join(f.base, "broker-target.json");
  await writeFile(target, JSON.stringify({
    version: 2,
    state_file: path.join(f.base, "context-handoff-v2", "0".repeat(64) + ".json"),
    session_hash: "0".repeat(64),
    expires_at: Date.now() + 60_000,
  }));
  try {
    await symlink(target, path.join(directory, hash + ".json"), "file");
    assert.deepEqual(await claimRequest(request, f), {
      ok: false,
      error: "REQUEST_NOT_FOUND",
    });
  } catch (error) {
    assert.equal(error?.code, "EPERM", "unexpected broker-symlink-test failure");
  }
});

test("claim rejects a junctioned broker parent directory", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const signal = await handleHookEvent(hookInput(f, "Stop"), f);
  const request = markerFromResult(signal);
  const base = path.join(
    f.codexHome,
    "plugin-data",
    "handoff-document-generator",
    "context-handoff-v2",
  );
  const requests = path.join(base, "requests");
  const moved = path.join(f.base, "moved-requests");
  await rename(requests, moved);
  try {
    await symlink(moved, requests, "junction");
    assert.deepEqual(await claimRequest(request, f), {
      ok: false,
      error: "REQUEST_NOT_FOUND",
    });
  } catch (error) {
    assert.equal(error?.code, "EPERM", "unexpected broker-junction-test failure");
  }
});

test("claim rejects a junctioned state parent directory", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const signal = await handleHookEvent(hookInput(f, "Stop"), f);
  const request = markerFromResult(signal);
  const stateDirectory = path.join(
    f.codexHome,
    "plugin-data",
    "handoff-document-generator",
    "context-handoff-v2",
    "states",
  );
  const moved = path.join(f.base, "moved-state");
  await rename(stateDirectory, moved);
  try {
    await symlink(moved, stateDirectory, "junction");
    assert.deepEqual(await claimRequest(request, f), {
      ok: false,
      error: "REQUEST_NOT_FOUND",
    });
  } catch (error) {
    assert.equal(error?.code, "EPERM", "unexpected state-junction-test failure");
  }
});

test("a stale lock owner cannot release the replacement owner's lock", async function (t) {
  const f = await fixtureSession(t, tokenEvent(1, 258400));
  const lock = path.join(f.base, "owned.lock");
  const now = Date.now();
  const first = await acquireLock(lock, now);
  assert.ok(first);
  const replacement = await acquireLock(lock, now + LOCK_TTL_MS + 1000);
  assert.ok(replacement);
  assert.notEqual(replacement, first);
  assert.equal(await releaseLock(lock, first), false);
  assert.equal(await acquireLock(lock, Date.now()), null);
  assert.equal(await releaseLock(lock, replacement), true);
});

test("lease checkpoints are ordered and use a same-byte scan receipt", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const result = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 10_000 });
  const claim = await claimRequest(markerFromResult(result), { ...f, now: 10_001 });
  const document = path.join(f.base, "HANDOFF.md");
  await writeFile(document, "# HANDOFF\n\nSafe synthetic handoff.\n");
  const scan = await scanFile(document);
  assert.equal(scan.ok, true);
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "scan_passed",
    document_sha256: scan.sha256,
  }, { ...f, now: 10_002 })).error, "INVALID_TRANSITION");
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "handoff_written",
    document_path: document,
    document_sha256: scan.sha256,
  }, { ...f, now: 10_002 })).ok, true);
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "scan_passed",
    document_sha256: "0".repeat(64),
  }, { ...f, now: 10_003 })).error, "DOCUMENT_HASH_MISMATCH");
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "scan_passed",
    document_sha256: scan.sha256,
  }, { ...f, now: 10_004 })).ok, true);
  assert.equal((await buildChildPrompt({
    lease: claim.lease,
    document_path: document,
    document_sha256: scan.sha256,
  }, { ...f, now: 10_004 })).error, "BACKUP_NOT_CREATED");
  const backupOptions = fixtureBackupOptions(t, f, 10_004);
  const backup = await backupAuthorized({
    lease: claim.lease,
    document_path: document,
    document_sha256: scan.sha256,
  }, backupOptions);
  assert.equal(backup.ok, true, JSON.stringify(backup));
  const childPrompt = await buildChildPrompt({
    lease: claim.lease,
    document_path: document,
    document_sha256: scan.sha256,
  }, backupOptions);
  assert.equal(childPrompt.ok, true);
  assert.match(childPrompt.prompt, /^Read HANDOFF\.md first and continue the project\./);
  assert.match(childPrompt.prompt, new RegExp(claim.handoff_id));
  assert.match(childPrompt.prompt, /Open it once, hash the exact bytes you read, and stop unless/);
  assert.match(childPrompt.prompt, /SHA-256 exactly matches/);
  assert.match(childPrompt.prompt, /Project backup receipt id:/);
  assert.doesNotMatch(childPrompt.prompt, /Project backup path:/);
  assert.doesNotMatch(childPrompt.prompt, new RegExp(claim.lease));
  for (const input of [
    { next_state: "creating_child", ...syntheticTaskTarget },
    { next_state: "child_created", child_id: "child-123" },
    { next_state: "title_set" },
    { next_state: "child_opened" },
    { next_state: "complete" },
  ]) {
    const checkpoint = await checkpointState({ lease: claim.lease, ...input }, { ...f, now: 10_004 });
    assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));
  }
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "complete",
  }, { ...f, now: 10_005 })).ok, false);
});

test("checkpoint renews the lease broker and state with one expiry", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400), "12121212-3434-4567-8899-abcdefabcdef");
  const claimAt = 70_001;
  const signal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: claimAt - 1 });
  const claim = await claimRequest(markerFromResult(signal), { ...f, now: claimAt });
  const document = path.join(f.base, "HANDOFF.md");
  await writeFile(document, "# HANDOFF\n\nLease renewal.\n");
  const scan = await scanFile(document);
  const lateCheckpoint = claimAt + LEASE_TTL_MS - 10;
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "handoff_written",
    document_path: document,
    document_sha256: scan.sha256,
  }, { ...f, now: lateCheckpoint })).ok, true);
  const afterOriginalBrokerExpiry = claimAt + LEASE_TTL_MS + 10;
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "scan_passed",
    document_sha256: scan.sha256,
  }, { ...f, now: afterOriginalBrokerExpiry })).ok, true);
  assert.equal(await handleHookEvent(hookInput(f, "Stop"), { ...f, now: afterOriginalBrokerExpiry + 1 }), null);
});

test("title_set recovery reuses the persisted project and title instead of renumbering", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400), "23232323-4545-4678-8a9b-bcdefabcdefa");
  const started = 75_000;
  const signal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: started });
  const claim = await claimRequest(markerFromResult(signal), { ...f, now: started + 1 });
  const document = path.join(f.base, "HANDOFF.md");
  await writeFile(document, "# HANDOFF\n\nDeterministic task recovery.\n");
  const scan = await scanFile(document);
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "handoff_written",
    document_path: document,
    document_sha256: scan.sha256,
  }, { ...f, now: started + 2 })).ok, true);
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "scan_passed",
    document_sha256: scan.sha256,
  }, { ...f, now: started + 3 })).ok, true);
  const options = fixtureBackupOptions(t, f, started + 4);
  assert.equal((await backupAuthorized({
    lease: claim.lease,
    document_path: document,
    document_sha256: scan.sha256,
  }, options)).ok, true);
  const persistedTarget = { project_id: "registered-original", child_title: "恢复任务（续接 1）" };
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "creating_child",
    project_id: claim.lease,
    child_title: persistedTarget.child_title,
  }, { ...options, now: started + 5 })).error, "TASK_TARGET_RECEIPT_REQUIRED");
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "creating_child",
    project_id: persistedTarget.project_id,
    child_title: claim.lease,
  }, { ...options, now: started + 5 })).error, "TASK_TARGET_RECEIPT_REQUIRED");
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "creating_child",
    project_id: persistedTarget.project_id,
    child_title: "ghp_" + "A".repeat(24),
  }, { ...options, now: started + 5 })).error, "TASK_TARGET_RECEIPT_REQUIRED");
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "creating_child",
    ...persistedTarget,
  }, { ...options, now: started + 5 })).ok, true);
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "creating_child",
    project_id: markerFromResult(signal),
    child_title: persistedTarget.child_title,
  }, { ...options, now: started + 5 })).error, "TASK_TARGET_ALREADY_RECORDED");
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "creating_child",
    project_id: persistedTarget.project_id,
    child_title: "恢复任务（续接 2）",
  }, { ...options, now: started + 5 })).error, "TASK_TARGET_ALREADY_RECORDED");
  const stateDirectory = path.join(f.codexHome, "plugin-data", "handoff-document-generator", "context-handoff-v2", "states");
  const stateFile = path.join(stateDirectory, (await readdir(stateDirectory)).find(function (name) { return name.endsWith(".json"); }));
  const creatingState = JSON.parse(await readFile(stateFile, "utf8"));
  await writeFile(stateFile, JSON.stringify({ ...creatingState, child_title: claim.lease }));
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "child_created",
    child_id: "persisted-child",
  }, { ...options, now: started + 6 })).error, "LEASE_NOT_FOUND");
  await writeFile(stateFile, JSON.stringify(creatingState));
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "child_created",
    child_id: claim.lease,
  }, { ...options, now: started + 6 })).error, "CHILD_ID_REQUIRED");
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "child_created",
    child_id: markerFromResult(signal),
  }, { ...options, now: started + 6 })).error, "CHILD_ID_REQUIRED");
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "child_created",
    child_id: "ghp_" + "B".repeat(24),
  }, { ...options, now: started + 6 })).error, "CHILD_ID_REQUIRED");
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "child_created",
    child_id: "persisted-child",
  }, { ...options, now: started + 6 })).ok, true);
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "child_created",
    child_id: claim.lease,
  }, { ...options, now: started + 6 })).error, "CHILD_ID_REQUIRED");
  const safeState = JSON.parse(await readFile(stateFile, "utf8"));
  await writeFile(stateFile, JSON.stringify({ ...safeState, child_id: claim.lease }));
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "title_set",
  }, { ...options, now: started + 7 })).error, "LEASE_NOT_FOUND");
  await writeFile(stateFile, JSON.stringify(safeState));
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "title_set",
  }, { ...options, now: started + 7 })).ok, true);

  const afterExpiry = started + 7 + LEASE_TTL_MS + 1;
  const resumedSignal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: afterExpiry });
  const resumed = await claimRequest(markerFromResult(resumedSignal), { ...f, now: afterExpiry + 1 });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.resume_stage, "title_set");
  assert.equal(resumed.child_id, "persisted-child");
  assert.equal(resumed.project_id, persistedTarget.project_id);
  assert.equal(resumed.child_title, persistedTarget.child_title);
  assert.equal(nextContinuationTitle("恢复任务", [persistedTarget.child_title]), "恢复任务（续接 2）");
  assert.equal((await checkpointState({
    lease: resumed.lease,
    next_state: "title_set",
    project_id: claim.lease,
    child_title: persistedTarget.child_title,
  }, { ...options, now: afterExpiry + 2 })).error, "TASK_TARGET_ALREADY_RECORDED");
  assert.equal((await checkpointState({
    lease: resumed.lease,
    next_state: "child_opened",
  }, { ...options, now: afterExpiry + 2 })).ok, true);
  assert.equal((await checkpointState({
    lease: resumed.lease,
    next_state: "complete",
  }, { ...options, now: afterExpiry + 3 })).ok, true);
});

test("handoff receipt requires the canonical workspace-root HANDOFF.md", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const signal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 15_000 });
  const claim = await claimRequest(markerFromResult(signal), { ...f, now: 15_001 });
  const nested = path.join(f.base, "nested");
  await mkdir(nested, { recursive: true });
  const document = path.join(nested, "HANDOFF.md");
  await writeFile(document, "# HANDOFF\n\nNested file must not be accepted.\n");
  const scan = await scanFile(document);
  const receipt = await checkpointState({
    lease: claim.lease,
    next_state: "handoff_written",
    document_path: document,
    document_sha256: scan.sha256,
  }, { ...f, now: 15_002 });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error, "UNSAFE_DOCUMENT_PATH");
});

test("handoff receipt rejects a symlink and prompt rejects post-scan mutation", async function (t) {
  const symlinkFixture = await fixtureSession(t, tokenEvent(179792, 258400), "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
  const symlinkSignal = await handleHookEvent(hookInput(symlinkFixture, "Stop"), { ...symlinkFixture, now: 16_000 });
  const symlinkClaim = await claimRequest(markerFromResult(symlinkSignal), { ...symlinkFixture, now: 16_001 });
  const target = path.join(symlinkFixture.base, "handoff-target.md");
  const link = path.join(symlinkFixture.base, "HANDOFF.md");
  await writeFile(target, "# HANDOFF\n\nLink target.\n");
  try {
    await symlink(target, link, "file");
    const scan = await scanFile(target);
    const receipt = await checkpointState({
      lease: symlinkClaim.lease,
      next_state: "handoff_written",
      document_path: link,
      document_sha256: scan.sha256,
    }, { ...symlinkFixture, now: 16_002 });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error, "UNSAFE_DOCUMENT_PATH");
  } catch (error) {
    assert.equal(error?.code, "EPERM", "unexpected handoff-symlink-test failure");
  }

  const f = await fixtureSession(t, tokenEvent(179792, 258400), "cccccccc-dddd-4eee-8fff-000000000000");
  const signal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 17_000 });
  const claim = await claimRequest(markerFromResult(signal), { ...f, now: 17_001 });
  const document = path.join(f.base, "HANDOFF.md");
  await writeFile(document, "# HANDOFF\n\nOriginal bytes.\n");
  const scan = await scanFile(document);
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "handoff_written",
    document_path: document,
    document_sha256: scan.sha256,
  }, { ...f, now: 17_002 })).ok, true);
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "scan_passed",
    document_sha256: scan.sha256,
  }, { ...f, now: 17_003 })).ok, true);
  const backupOptions = fixtureBackupOptions(t, f, 17_003);
  const backup = await backupAuthorized({
    lease: claim.lease,
    document_path: document,
    document_sha256: scan.sha256,
  }, backupOptions);
  assert.equal(backup.ok, true, JSON.stringify(backup));
  await writeFile(document, "# HANDOFF\n\nMutated after receipt.\n");
  const prompt = await buildChildPrompt({
    lease: claim.lease,
    document_path: document,
    document_sha256: scan.sha256,
  }, { ...backupOptions, now: 17_004 });
  assert.equal(prompt.ok, false);
  assert.equal(prompt.error, "DOCUMENT_HASH_MISMATCH");
});

test("Windows 8.3 aliases survive the real CLI receipt and authorized scan", async function (t) {
  if (process.platform !== "win32") return t.skip("Windows-only path alias regression");
  const f = await fixtureSession(t, tokenEvent(179792, 258400), "dddddddd-eeee-4fff-8000-111111111111");
  let shortBase = await windowsShortPath(f.base);
  if (!shortBase || shortBase.toLowerCase() === f.base.toLowerCase()) {
    const aliasRoot = path.join(workRoot, "ADMINI~1-" + path.basename(f.base));
    try {
      await symlink(workRoot, aliasRoot, "junction");
      t.after(async function () { await rmdir(aliasRoot).catch(function () {}); });
      shortBase = path.join(aliasRoot, path.basename(f.base));
    } catch (error) {
      if (error?.code === "EPERM") return t.skip("path aliases unavailable on this volume");
      throw error;
    }
  }
  const script = path.join(projectRoot, "scripts", "context-handoff.mjs");
  const environment = { ...process.env, CODEX_HOME: f.codexHome };
  const hook = spawnSync(process.execPath, [script, "hook"], {
    input: JSON.stringify(hookInput(f, "Stop", { cwd: shortBase })),
    encoding: "utf8",
    env: environment,
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.ok(hook.stdout, JSON.stringify({ shortBase, longBase: f.base, stderr: hook.stderr }));
  const request = markerFromResult(JSON.parse(hook.stdout));
  assert.ok(request);
  const claimProcess = spawnSync(process.execPath, [script, "claim"], {
    input: JSON.stringify({ request }),
    encoding: "utf8",
    env: environment,
  });
  assert.equal(claimProcess.status, 0, claimProcess.stderr);
  const claim = JSON.parse(claimProcess.stdout);
  assert.equal(claim.ok, true);

  const shortDocument = path.join(shortBase, "HANDOFF.md");
  await writeFile(shortDocument, "# HANDOFF\n\nWindows short-path receipt.\n");
  const scan = JSON.parse(spawnSync(process.execPath, [script, "scan"], {
    input: JSON.stringify({ workspace_root: shortBase, document_path: shortDocument }),
    encoding: "utf8",
    env: environment,
  }).stdout);
  assert.equal(scan.ok, true);
  const checkpoint = spawnSync(process.execPath, [script, "checkpoint"], {
    input: JSON.stringify({
      lease: claim.lease,
      next_state: "handoff_written",
      document_path: shortDocument,
      document_sha256: scan.sha256,
    }),
    encoding: "utf8",
    env: environment,
  });
  assert.equal(checkpoint.status, 0, checkpoint.stdout + checkpoint.stderr);
  assert.equal(JSON.parse(checkpoint.stdout).ok, true);
  const authorized = spawnSync(process.execPath, [script, "scan-authorized"], {
    input: JSON.stringify({ lease: claim.lease, document_path: shortDocument }),
    encoding: "utf8",
    env: environment,
  });
  assert.equal(authorized.status, 0, authorized.stdout + authorized.stderr);
  assert.equal(JSON.parse(authorized.stdout).ok, true);
});

test("authorized scan catches unlabeled raw request and lease capabilities", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const signal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 20_000 });
  const request = markerFromResult(signal);
  const claim = await claimRequest(request, { ...f, now: 20_001 });
  const document = path.join(f.base, "HANDOFF.md");
  await writeFile(document, ["# HANDOFF", request, claim.lease, "A" + claim.lease + "B"].join("\n"));
  const ordinary = await scanFile(document);
  assert.equal(ordinary.ok, true);
  const receipt = await checkpointState({
    lease: claim.lease,
    next_state: "handoff_written",
    document_path: document,
    document_sha256: ordinary.sha256,
  }, { ...f, now: 20_002 });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error, "DOCUMENT_SCAN_FAILED");
  assert.equal(JSON.stringify(receipt).includes(request), false);
  assert.equal(JSON.stringify(receipt).includes(claim.lease), false);
});

test("PostCompact-retired lease remains blocked by the replacement lease scan", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const firstSignal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 30_000 });
  const firstClaim = await claimRequest(markerFromResult(firstSignal), { ...f, now: 30_001 });
  await handleHookEvent(hookInput(f, "PostCompact", { trigger: "auto" }), { ...f, now: 30_002 });
  await writeFile(f.transcript, sessionMeta(f.id) + "\n" + tokenEvent(1000, 258400) + "\n");
  const secondSignal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 30_003 });
  const secondClaim = await claimRequest(markerFromResult(secondSignal), { ...f, now: 30_004 });
  const document = path.join(f.base, "HANDOFF.md");
  await writeFile(document, ["# HANDOFF", firstClaim.lease].join("\n"));
  const ordinary = await scanFile(document);
  const receipt = await checkpointState({
    lease: secondClaim.lease,
    next_state: "handoff_written",
    document_path: document,
    document_sha256: ordinary.sha256,
  }, { ...f, now: 30_005 });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error, "DOCUMENT_SCAN_FAILED");
});

test("expired lease reissues a request and resumes creating_child with same handoff_id", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400));
  const first = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 1000 });
  const claim = await claimRequest(markerFromResult(first), { ...f, now: 1001 });
  const document = path.join(f.base, "HANDOFF.md");
  await writeFile(document, "# HANDOFF\n");
  const digest = createHash("sha256").update(await readFile(document)).digest("hex");
  for (const input of [
    { next_state: "handoff_written", document_path: document, document_sha256: digest },
    { next_state: "scan_passed", document_sha256: digest },
  ]) {
    assert.equal((await checkpointState({ lease: claim.lease, ...input }, { ...f, now: 1002 })).ok, true);
  }
  const backupOptions = fixtureBackupOptions(t, f, 1002);
  assert.equal((await backupAuthorized({
    lease: claim.lease,
    document_path: document,
    document_sha256: digest,
  }, backupOptions)).ok, true);
  assert.equal((await checkpointState({
    lease: claim.lease,
    next_state: "creating_child",
    ...syntheticTaskTarget,
  }, { ...backupOptions, now: 1002 })).ok, true);
  const later = 1001 + 61 * 60 * 1000;
  const resumedSignal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: later });
  const resumed = await claimRequest(markerFromResult(resumedSignal), { ...f, now: later + 1 });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resume_stage, "creating_child");
  assert.equal(resumed.handoff_id, claim.handoff_id);
  assert.equal(resumed.project_id, syntheticTaskTarget.project_id);
  assert.equal(resumed.child_title, syntheticTaskTarget.child_title);
});

test("scanner rejects secrets and handoff capabilities without echoing values", async function (t) {
  const f = await fixtureSession(t, tokenEvent(1, 258400));
  const secret = "ghp_" + "Z".repeat(40);
  const target = path.join(f.base, "HANDOFF.md");
  await writeFile(target, [
    "TOKEN=" + secret,
    "CODEX_HANDOFF_V2 request=" + "A".repeat(32),
  ].join("\n"));
  const result = await scanFile(target);
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(function (item) { return item.ruleId; }).sort(), [
    "ENV_SECRET_ASSIGNMENT",
    "HANDOFF_CAPABILITY",
    "TOKEN_PREFIX",
  ]);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(scanSecrets("TOKEN=<redacted>").length, 0);
});

test("manual scanner keeps hostile document paths out of argv and roots them by workspace", async function (t) {
  await mkdir(workRoot, { recursive: true });
  const base = await mkdtemp(path.join(workRoot, "test-scan-$() & '-"));
  t.after(async function () { await rm(base, { recursive: true, force: true }); });
  const target = path.join(base, "HANDOFF.md");
  await writeFile(target, "# HANDOFF\n");
  const request = { workspace_root: base, document_path: target };
  assert.equal((await scanManualRequest(request)).ok, true);

  const script = path.join(projectRoot, "scripts", "context-handoff.mjs");
  const scanned = spawnSync(process.execPath, [script, "scan"], {
    encoding: "utf8",
    input: JSON.stringify(request),
  });
  assert.equal(scanned.status, 0);
  assert.equal(scanned.stderr, "");
  assert.equal(JSON.parse(scanned.stdout).ok, true);

  const legacyArgv = spawnSync(process.execPath, [script, "scan", target], {
    encoding: "utf8",
  });
  assert.equal(legacyArgv.status, 3);
  assert.deepEqual(JSON.parse(legacyArgv.stdout), {
    ok: false,
    error: "INVALID_SCAN_REQUEST",
    findings: [],
  });

  const oversized = spawnSync(process.execPath, [script, "scan"], {
    encoding: "utf8",
    input: JSON.stringify({ workspace_root: "x".repeat(70 * 1024), document_path: target }),
  });
  assert.equal(oversized.status, 3);
  assert.equal(JSON.parse(oversized.stdout).error, "INVALID_SCAN_REQUEST");

  const nested = path.join(base, "nested");
  await mkdir(nested);
  const outsideRoot = path.join(nested, "HANDOFF.md");
  await writeFile(outsideRoot, "# HANDOFF\n");
  assert.equal((await scanManualRequest({
    workspace_root: base,
    document_path: outsideRoot,
  })).error, "INVALID_SCAN_TARGET");
});

test("scan CLI returns only findings and same-handle digest metadata through stdin", async function (t) {
  const f = await fixtureSession(t, tokenEvent(1, 258400));
  const target = path.join(f.base, "HANDOFF.md");
  const secret = "sk-" + "Q".repeat(32);
  await writeFile(target, "OPENAI_API_KEY=" + secret);
  const scanned = spawnSync(
    process.execPath,
    [path.join(projectRoot, "scripts", "context-handoff.mjs"), "scan"],
    {
      encoding: "utf8",
      input: JSON.stringify({ workspace_root: f.base, document_path: target }),
    },
  );
  assert.equal(scanned.status, 2);
  assert.equal(scanned.stdout.includes(secret), false);
  const output = JSON.parse(scanned.stdout);
  assert.equal(output.ok, false);
  assert.match(output.sha256, /^[a-f0-9]{64}$/);
  assert.ok(output.findings.every(function (finding) {
    return Object.keys(finding).sort().join(",") === "line,ruleId";
  }));
});

test("backup roots use configured or CODEX storage roots and reject unconfigured siblings", async function (t) {
  await mkdir(workRoot, { recursive: true });
  const parent = await mkdtemp(path.join(workRoot, "test-backup-roots-"));
  t.after(async function () { await rm(parent, { recursive: true, force: true }); });
  const storage = path.join(parent, "CODEX存储目录");
  const workspace = path.join(storage, "中文项目");
  await mkdir(workspace, { recursive: true });
  assert.equal(await resolveBackupRoot(workspace, { env: {} }), path.join(storage, "项目备份"));
  const configured = path.join(parent, "自定义备份");
  assert.equal(await resolveBackupRoot(workspace, {
    env: { CODEX_HANDOFF_BACKUP_ROOT: configured },
  }), configured);
  await assert.rejects(resolveBackupRoot(workspace, {
    env: { CODEX_HANDOFF_BACKUP_ROOT: path.join(workspace, "inside") },
  }), /BACKUP_ROOT_OVERLAP/);
  await assert.rejects(resolveBackupRoot(workspace, {
    env: { CODEX_HANDOFF_BACKUP_ROOT: "relative-backup" },
  }), /BACKUP_ROOT_UNSAFE/);
  if (process.platform === "win32") {
    await assert.rejects(resolveBackupRoot(workspace, {
      env: { CODEX_HANDOFF_BACKUP_ROOT: "\\\\server\\share\\backup" },
    }), /BACKUP_ROOT_UNSAFE/);
  }
  const publicWorkspace = path.join(parent, "public-parent", "plain-project");
  await mkdir(publicWorkspace, { recursive: true });
  await assert.rejects(resolveBackupRoot(publicWorkspace, {
    env: {}, testing: true, ancestorBoundary: parent,
  }), /BACKUP_ROOT_CONFIGURATION_REQUIRED/);
});

test("root marker first-use publication is atomic across 32 high-contention iterations", async function (t) {
  await mkdir(workRoot, { recursive: true });
  const parent = await mkdtemp(path.join(workRoot, "test-root-race-"));
  t.after(async function () { await rm(parent, { recursive: true, force: true, maxRetries: 8, retryDelay: 20 }); });
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const workspace = path.join(parent, `workspace-${iteration}`);
    const backupRoot = path.join(parent, `backup-${iteration}`);
    await mkdir(workspace);
    const options = { env: { CODEX_HANDOFF_BACKUP_ROOT: backupRoot } };
    const roots = await Promise.all(Array.from({ length: 24 }, function () {
      return resolveBackupRoot(workspace, options);
    }));
    assert.equal(new Set(roots).size, 1);
    const marker = JSON.parse(await readFile(path.join(backupRoot, ".handoff-backup-root-v1.json"), "utf8"));
    assert.match(marker.root_id, /^[a-f0-9]{32}$/u);
    assert.match(marker.auth_key, /^[a-f0-9]{64}$/u);
    assert.equal((await readdir(backupRoot)).some(function (name) {
      return name.includes("root-marker-init") || name.endsWith(".init.lock");
    }), false);
  }
});

test("manual backup includes broad safe project files and emits Chinese integrity artifacts", async function (t) {
  const f = await backupWorkspace(t, "中文 示例");
  await mkdir(path.join(f.workspace, "src"), { recursive: true });
  await mkdir(path.join(f.workspace, "docs", "nested"), { recursive: true });
  await mkdir(path.join(f.workspace, "scripts"), { recursive: true });
  await mkdir(path.join(f.workspace, "tests"), { recursive: true });
  await mkdir(path.join(f.workspace, ".codex"), { recursive: true });
  await writeFile(path.join(f.workspace, "src", "模块.weirdlang"), "函数 main() { 返回 1 }\n");
  await writeFile(path.join(f.workspace, "README.md"), "# 文档\n");
  await writeFile(path.join(f.workspace, "docs", "nested", "全部安全.md"), "# 嵌套文档\n");
  await writeFile(path.join(f.workspace, "scripts", "build.mjs"), "export default true;\n");
  await writeFile(path.join(f.workspace, "tests", "safe.test.ts"), "export const ok = true;\n");
  await writeFile(path.join(f.workspace, "package-lock.json"), "{}\n");
  await writeFile(path.join(f.workspace, ".codex", "config.toml"), "model = \"safe\"\n");
  await writeFile(path.join(f.workspace, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  const backup = await backupManualRequest({
    workspace_root: f.workspace,
    document_path: f.document,
    document_sha256: f.documentSha256,
  }, f.options);
  assert.equal(backup.ok, true, JSON.stringify(backup));
  assert.match(backup.backup_path, /project-[a-f0-9]{16}（项目备份）/u);
  assert.match(path.basename(backup.backup_path), /^2026年07月28日-16时09分10秒-[a-f0-9]{16}$/u);
  const manifest = JSON.parse(await readFile(path.join(backup.backup_path, "备份清单.json"), "utf8"));
  const included = manifest.files.map(function (item) { return item.path; });
  for (const expected of ["HANDOFF.md", "README.md", "docs/nested/全部安全.md", "scripts/build.mjs", "tests/safe.test.ts", "package-lock.json", "src/模块.weirdlang", ".codex/config.toml", "logo.png"]) {
    assert.ok(included.includes(expected), expected);
  }
  const documentation = await readFile(path.join(backup.backup_path, "备份说明.md"), "utf8");
  assert.match(documentation, /## 源与备份映射/u);
  assert.match(documentation, /## 完整性说明/u);
  assert.match(documentation, /## 恢复、安装、测试与部署/u);
  const checksums = await readFile(path.join(backup.backup_path, "文件校验.sha256"), "utf8");
  assert.match(checksums, /项目文件\/HANDOFF\.md/u);
  assert.equal((await verifyBackupReceipt(backup, {
    workspaceRoot: f.workspace,
    documentSha256: f.documentSha256,
  }, f.options)).ok, true);
});

test("backup deny rules run before reads and secret findings never echo content", async function (t) {
  const f = await backupWorkspace(t, "deny-project");
  const secret = "ghp_" + "S".repeat(40);
  await mkdir(path.join(f.workspace, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(f.workspace, "node_modules", "pkg", "index.js"), secret);
  await writeFile(path.join(f.workspace, ".env.local"), "TOKEN=" + secret);
  await writeFile(path.join(f.workspace, "notes.txt"), "credential=" + secret);
  await writeFile(path.join(f.workspace, "data.sqlite"), secret);
  await writeFile(path.join(f.workspace, "unknown.dat"), Buffer.from([0, 1, 2, 3]));
  const opened = [];
  const result = await createProjectBackup({
    workspaceRoot: f.workspace,
    documentSha256: f.documentSha256,
    purpose: "safe",
  }, { ...f.options, testing: true, onBeforeSourceOpen(relative) { opened.push(relative); } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const manifestText = await readFile(path.join(result.backup_path, "备份清单.json"), "utf8");
  assert.equal(manifestText.includes(secret), false);
  const manifest = JSON.parse(manifestText);
  assert.ok(manifest.exclusions.every(function (item) {
    return /^[a-f0-9]{64}$/.test(item.path_digest) && !Object.hasOwn(item, "path");
  }));
  const rules = new Set(manifest.exclusions.map(function (item) { return item.rule_id; }));
  for (const rule of ["DENY_DEPENDENCIES", "DENY_ENV_FILE", "TOKEN_PREFIX", "DENY_DATABASE", "DENY_UNSAFE_BINARY"]) {
    assert.ok(rules.has(rule), rule);
  }
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(opened.includes(".env.local"), false);
  assert.equal(opened.includes("data.sqlite"), false);
  assert.equal(opened.some(function (item) { return item.startsWith("node_modules/"); }), false);
});

test("links are excluded and oversized files abort without a published snapshot", async function (t) {
  const f = await backupWorkspace(t, "atomic-project");
  const outside = path.join(f.parent, "outside.txt");
  const link = path.join(f.workspace, "linked.txt");
  await writeFile(outside, "outside\n");
  try {
    await symlink(outside, link, "file");
    const linked = await createProjectBackup({
      workspaceRoot: f.workspace,
      documentSha256: f.documentSha256,
      purpose: "safe",
    }, f.options);
    assert.equal(linked.ok, true, JSON.stringify(linked));
    const manifest = JSON.parse(await readFile(path.join(linked.backup_path, "备份清单.json"), "utf8"));
    assert.ok(manifest.exclusions.some(function (item) { return item.rule_id === "DENY_LINK"; }));
  } catch (error) {
    assert.equal(error?.code, "EPERM", "unexpected symlink-test failure");
  }
  const huge = path.join(f.workspace, "huge.txt");
  const handle = await open(huge, "w");
  await handle.truncate(BACKUP_MAX_FILE_BYTES + 1);
  await handle.close();
  const failedOptions = { ...f.options, now: new Date("2026-07-28T08:09:11.000Z") };
  const failed = await createProjectBackup({
    workspaceRoot: f.workspace,
    documentSha256: f.documentSha256,
    purpose: "safe",
  }, failedOptions);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "BACKUP_FILE_QUOTA_EXCEEDED");
  const rootEntries = await readdir(f.backupRoot);
  const projectBackup = path.join(f.backupRoot, rootEntries.find(function (name) { return /^project-[a-f0-9]{16}（项目备份）$/u.test(name); }));
  const entries = await readdir(projectBackup);
  assert.equal(entries.some(function (name) { return name.includes("08时09分11秒") || name.includes(".partial-"); }), false);
});

test("automatic backups are idempotent and concurrent attempts cannot overwrite", async function (t) {
  const f = await backupWorkspace(t, "idempotent-project");
  const input = {
    workspaceRoot: f.workspace,
    documentSha256: f.documentSha256,
    handoffId: "abcdefghijklmnopqrstuv",
    purpose: "safe",
  };
  const [left, right] = await Promise.all([
    createProjectBackup(input, f.options),
    createProjectBackup(input, f.options),
  ]);
  assert.equal([left, right].filter(function (item) { return item.ok; }).length, 1);
  assert.ok([left, right].some(function (item) { return item.error === "BACKUP_BUSY"; }));
  const reused = await createProjectBackup(input, f.options);
  assert.equal(reused.ok, true, JSON.stringify(reused));
  assert.equal(reused.reused, true);
  assert.equal(reused.backup_path, (left.ok ? left : right).backup_path);
  const manualOne = await createProjectBackup({ ...input, handoffId: undefined }, {
    ...f.options, now: new Date("2026-07-28T08:09:12.000Z"),
  });
  const manualTwo = await createProjectBackup({ ...input, handoffId: undefined }, {
    ...f.options, now: new Date("2026-07-28T08:09:12.000Z"),
  });
  assert.equal(manualOne.ok, true);
  assert.equal(manualTwo.ok, true);
  assert.notEqual(manualOne.backup_path, manualTwo.backup_path);
});

test("backup CLI consumes stdin and ignores caller-supplied backup roots", async function (t) {
  const f = await backupWorkspace(t, "cli-project");
  const script = path.join(projectRoot, "scripts", "context-handoff.mjs");
  const hostile = path.join(f.workspace, "caller-controlled");
  const run = spawnSync(process.execPath, [script, "backup"], {
    input: JSON.stringify({
      workspace_root: f.workspace,
      document_path: f.document,
      document_sha256: f.documentSha256,
      backup_root: hostile,
    }),
    encoding: "utf8",
    env: { ...process.env, CODEX_HANDOFF_BACKUP_ROOT: f.backupRoot },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.backup_path.startsWith(f.backupRoot + path.sep), true);
  assert.equal(await lstat(hostile).then(function () { return true; }, function () { return false; }), false);
});

test("tampered backup receipts block child prompts", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400), "eeeeeeee-ffff-4000-8111-222222222222");
  const signal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 40_000 });
  const claim = await claimRequest(markerFromResult(signal), { ...f, now: 40_001 });
  const document = path.join(f.base, "HANDOFF.md");
  await writeFile(document, "# HANDOFF\n\nSafe receipt test.\n");
  const scan = await scanFile(document);
  assert.equal((await checkpointState({
    lease: claim.lease, next_state: "handoff_written", document_path: document,
    document_sha256: scan.sha256,
  }, { ...f, now: 40_002 })).ok, true);
  assert.equal((await checkpointState({
    lease: claim.lease, next_state: "scan_passed", document_sha256: scan.sha256,
  }, { ...f, now: 40_003 })).ok, true);
  const options = fixtureBackupOptions(t, f, 40_004);
  const backup = await backupAuthorized({
    lease: claim.lease, document_path: document, document_sha256: scan.sha256,
  }, options);
  assert.equal(backup.ok, true, JSON.stringify(backup));
  await writeFile(path.join(backup.backup_path, "备份说明.md"), "tampered\n");
  const prompt = await buildChildPrompt({
    lease: claim.lease, document_path: document, document_sha256: scan.sha256,
  }, options);
  assert.equal(prompt.ok, false);
  assert.equal(prompt.error, "BACKUP_RECEIPT_INVALID");
});

test("automatic backup isolates capabilities in binary bytes and path metadata without echo", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400), "bbbb0000-cccc-4333-8444-555555555555");
  const signal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 45_000 });
  const claim = await claimRequest(markerFromResult(signal), { ...f, now: 45_001 });
  const document = path.join(f.base, "HANDOFF.md");
  await writeFile(document, "# HANDOFF\n\nBinary capability isolation.\n");
  const scan = await scanFile(document);
  assert.equal((await checkpointState({ lease: claim.lease, next_state: "handoff_written", document_path: document, document_sha256: scan.sha256 }, { ...f, now: 45_002 })).ok, true);
  assert.equal((await checkpointState({ lease: claim.lease, next_state: "scan_passed", document_sha256: scan.sha256 }, { ...f, now: 45_003 })).ok, true);
  const prefix = Buffer.alloc(1024 * 1024 - 10, 0);
  await writeFile(path.join(f.base, "asset.png"), Buffer.concat([prefix, Buffer.from(claim.lease), Buffer.from([0, 1, 2])]));
  await writeFile(path.join(f.base, claim.lease + ".md"), "safe body\n");
  const options = fixtureBackupOptions(t, f, 45_004);
  const backup = await backupAuthorized({ lease: claim.lease, document_path: document, document_sha256: scan.sha256 }, options);
  assert.equal(backup.ok, true, JSON.stringify(backup));
  const manifestText = await readFile(path.join(backup.backup_path, "备份清单.json"), "utf8");
  assert.equal(manifestText.includes(claim.lease), false);
  const manifest = JSON.parse(manifestText);
  assert.ok(manifest.exclusions.some(function (item) { return item.rule_id === "HANDOFF_CAPABILITY"; }));
  assert.ok(manifest.exclusions.every(function (item) { return !Object.hasOwn(item, "path"); }));
});

test("candidate scan completes before destination creation and scan failure remains unpublished", async function (t) {
  const f = await backupWorkspace(t, "scan-first-project");
  await writeFile(path.join(f.workspace, "src.txt"), "ordinary source\n");
  let observed = false;
  const result = await createProjectBackup({ workspaceRoot: f.workspace, documentSha256: f.documentSha256, purpose: "safe" }, {
    ...f.options,
    testing: true,
    async afterCandidateScan(relative, destination) {
      if (relative !== "src.txt") return;
      observed = true;
      assert.equal(await lstat(destination).then(function () { return true; }, function () { return false; }), false);
      throw new Error("stop after verified scan");
    },
  });
  assert.equal(observed, true);
  assert.equal(result.ok, false);
  const projectDirs = (await readdir(f.backupRoot)).filter(function (name) { return name.startsWith("project-"); });
  const entries = await readdir(path.join(f.backupRoot, projectDirs[0]));
  assert.equal(entries.some(function (name) { return name.includes("partial") || /^2026年/u.test(name); }), false);
});

test("root marker drift before signing and after publication never returns an unverifiable snapshot", async function (t) {
  const beforeSigning = await backupWorkspace(t, "marker-drift-scan");
  let changedBeforeSigning = false;
  const scanDrift = await createProjectBackup({ workspaceRoot: beforeSigning.workspace, documentSha256: beforeSigning.documentSha256, purpose: "safe" }, {
    ...beforeSigning.options,
    testing: true,
    async afterCandidateScan() {
      if (changedBeforeSigning) return;
      changedBeforeSigning = true;
      await writeFile(path.join(beforeSigning.backupRoot, ".handoff-backup-root-v1.json"), JSON.stringify({
        version: 1,
        root_id: "a".repeat(32),
        auth_key: "b".repeat(64),
        created_at: new Date().toISOString(),
      }) + "\n");
    },
  });
  assert.equal(scanDrift.error, "BACKUP_ROOT_MARKER_CHANGED");

  const publication = await backupWorkspace(t, "marker-drift-published");
  const publishedDrift = await createProjectBackup({ workspaceRoot: publication.workspace, documentSha256: publication.documentSha256, purpose: "safe" }, {
    ...publication.options,
    testing: true,
    async afterPublication(_snapshot, markerPath) {
      await writeFile(markerPath, JSON.stringify({
        version: 1,
        root_id: "c".repeat(32),
        auth_key: "d".repeat(64),
        created_at: new Date().toISOString(),
      }) + "\n");
    },
  });
  assert.equal(publishedDrift.error, "BACKUP_POST_PUBLICATION_VERIFY_FAILED");
  const projectName = (await readdir(publication.backupRoot)).find(function (name) { return name.startsWith("project-"); });
  const residue = await readdir(path.join(publication.backupRoot, projectName));
  assert.equal(residue.some(function (name) {
    return /^2026年/u.test(name) || name.includes("partial") || name.includes("retracted") || name.includes("stale-lock") || name.endsWith(".lock");
  }), false);
});

test("receipt verification rejects extra files, coordinated documentation rewrite, and manifest read races", async function (t) {
  const extra = await backupWorkspace(t, "tamper-extra");
  const extraReceipt = await backupManualRequest({ workspace_root: extra.workspace, document_path: extra.document, document_sha256: extra.documentSha256 }, extra.options);
  assert.equal(extraReceipt.ok, true);
  await writeFile(path.join(extraReceipt.backup_path, "extra.txt"), "extra\n");
  assert.equal((await verifyBackupReceipt(extraReceipt, { workspaceRoot: extra.workspace, documentSha256: extra.documentSha256 }, extra.options)).ok, false);

  const coordinated = await backupWorkspace(t, "tamper-coordinated");
  const coordinatedReceipt = await backupManualRequest({ workspace_root: coordinated.workspace, document_path: coordinated.document, document_sha256: coordinated.documentSha256 }, coordinated.options);
  assert.equal(coordinatedReceipt.ok, true);
  const docsPath = path.join(coordinatedReceipt.backup_path, "备份说明.md");
  await writeFile(docsPath, "coordinated rewrite\n");
  const docsHash = createHash("sha256").update(await readFile(docsPath)).digest("hex");
  const checksumPath = path.join(coordinatedReceipt.backup_path, "文件校验.sha256");
  const rewritten = (await readFile(checksumPath, "utf8")).replace(/^[a-f0-9]{64}  备份说明\.md$/mu, docsHash + "  备份说明.md");
  await writeFile(checksumPath, rewritten);
  assert.equal((await verifyBackupReceipt(coordinatedReceipt, { workspaceRoot: coordinated.workspace, documentSha256: coordinated.documentSha256 }, coordinated.options)).ok, false);

  const raced = await backupWorkspace(t, "tamper-race");
  const racedReceipt = await backupManualRequest({ workspace_root: raced.workspace, document_path: raced.document, document_sha256: raced.documentSha256 }, raced.options);
  assert.equal(racedReceipt.ok, true);
  let changed = false;
  const racedVerification = await verifyBackupReceipt(racedReceipt, { workspaceRoot: raced.workspace, documentSha256: raced.documentSha256 }, {
    ...raced.options, testing: true,
    async afterManifestRead(tree) {
      if (changed) return;
      changed = true;
      await writeFile(path.join(tree, "备份清单.json"), (await readFile(path.join(tree, "备份清单.json"), "utf8")) + " ");
    },
  });
  assert.equal(racedVerification.ok, false);
});

test("same-basename workspaces use distinct hashed project parents", async function (t) {
  const f = await backupWorkspace(t, "container");
  const one = path.join(f.workspace, "one", "app");
  const two = path.join(f.workspace, "two", "app");
  await mkdir(one, { recursive: true });
  await mkdir(two, { recursive: true });
  await writeFile(path.join(one, "HANDOFF.md"), "# HANDOFF\n\nOne.\n");
  await writeFile(path.join(two, "HANDOFF.md"), "# HANDOFF\n\nTwo.\n");
  const oneHash = createHash("sha256").update(await readFile(path.join(one, "HANDOFF.md"))).digest("hex");
  const twoHash = createHash("sha256").update(await readFile(path.join(two, "HANDOFF.md"))).digest("hex");
  const oneReceipt = await createProjectBackup({ workspaceRoot: one, documentSha256: oneHash, purpose: "one" }, f.options);
  const twoReceipt = await createProjectBackup({ workspaceRoot: two, documentSha256: twoHash, purpose: "two" }, f.options);
  assert.equal(oneReceipt.ok, true, JSON.stringify(oneReceipt));
  assert.equal(twoReceipt.ok, true, JSON.stringify(twoReceipt));
  assert.notEqual(path.dirname(oneReceipt.backup_path), path.dirname(twoReceipt.backup_path));
  assert.match(path.basename(path.dirname(oneReceipt.backup_path)), /^project-[a-f0-9]{16}（项目备份）$/u);
});

test("stale heartbeat lock recovers only its owned partial and retry succeeds", async function (t) {
  const f = await backupWorkspace(t, "stale-lock-project");
  const input = { workspaceRoot: f.workspace, documentSha256: f.documentSha256, handoffId: "abcdefghijklmnopqrstuv", operationId: "1".repeat(32), purpose: "safe" };
  const crashed = await createProjectBackup(input, { ...f.options, testing: true, injectFailure: "simulated_crash" });
  assert.equal(crashed.error, "BACKUP_SIMULATED_CRASH");
  const projectName = (await readdir(f.backupRoot)).find(function (name) { return name.startsWith("project-"); });
  const projectDirectory = path.join(f.backupRoot, projectName);
  const lockName = (await readdir(projectDirectory)).find(function (name) { return name.endsWith(".lock"); });
  const lockFile = path.join(projectDirectory, lockName, "lock.json");
  const lock = JSON.parse(await readFile(lockFile, "utf8"));
  lock.heartbeat_at = Date.now() - 11 * 60 * 1000;
  await writeFile(lockFile, JSON.stringify(lock) + "\n");
  const recovered = await createProjectBackup({ ...input, operationId: "2".repeat(32) }, f.options);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal((await readdir(projectDirectory)).some(function (name) { return name.includes("partial") || name.includes("stale-lock") || name.endsWith(".lock"); }), false);
});

test("stale empty and partial lock initialization recovers while one-sided ownership fails closed", async function (t) {
  const staleTime = new Date(Date.now() - 11 * 60 * 1000);
  const rootInit = await backupWorkspace(t, "stale-root-init");
  await mkdir(rootInit.backupRoot, { recursive: true });
  const rootInitLock = path.join(rootInit.backupRoot, ".handoff-backup-root-v1.init.lock");
  await mkdir(rootInitLock);
  await utimes(rootInitLock, staleTime, staleTime);
  assert.equal(await resolveBackupRoot(rootInit.workspace, rootInit.options), rootInit.backupRoot);
  assert.equal((await readdir(rootInit.backupRoot)).some(function (name) { return name.includes("stale-root-marker-init") || name.endsWith(".init.lock"); }), false);

  async function lockFixture(label, suffix) {
    const f = await backupWorkspace(t, label);
    const root = await resolveBackupRoot(f.workspace, f.options);
    const canonical = await realpath(f.workspace);
    const normalized = process.platform === "win32" ? path.resolve(canonical).toLowerCase() : path.resolve(canonical);
    const workspaceHash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    const projectDirectory = path.join(root, `project-${workspaceHash}（项目备份）`);
    await mkdir(projectDirectory);
    const handoffId = `abcdefghijklmnopqrstu${suffix}`;
    const stableId = createHash("sha256").update(handoffId + "\0" + f.documentSha256).digest("hex").slice(0, 16);
    const operationId = suffix.repeat(32);
    const lockDirectory = path.join(projectDirectory, `.backup-${stableId}.lock`);
    const lock = {
      version: 1,
      operation_id: operationId,
      owner: (suffix === "1" ? "a" : "b").repeat(32),
      workspace_hash: workspaceHash,
      partial_name: `.partial-${operationId}-${stableId}`,
      final_name: `2026年07月28日-16时09分10秒-${stableId}`,
      heartbeat_at: Date.now() - 11 * 60 * 1000,
    };
    return { f, handoffId, projectDirectory, lockDirectory, lock };
  }

  const empty = await lockFixture("stale-empty-lock", "1");
  await mkdir(empty.lockDirectory);
  await utimes(empty.lockDirectory, staleTime, staleTime);
  const emptyRecovered = await createProjectBackup({ workspaceRoot: empty.f.workspace, documentSha256: empty.f.documentSha256, handoffId: empty.handoffId, purpose: "safe" }, empty.f.options);
  assert.equal(emptyRecovered.ok, true, JSON.stringify(emptyRecovered));
  assert.equal((await readdir(empty.projectDirectory)).some(function (name) { return name.includes("stale-lock") || name.endsWith(".lock"); }), false);

  const partialInit = await lockFixture("stale-partial-lock", "2");
  await mkdir(partialInit.lockDirectory);
  await writeFile(path.join(partialInit.lockDirectory, "lock.json"), JSON.stringify(partialInit.lock) + "\n");
  const partialRecovered = await createProjectBackup({ workspaceRoot: partialInit.f.workspace, documentSha256: partialInit.f.documentSha256, handoffId: partialInit.handoffId, purpose: "safe" }, partialInit.f.options);
  assert.equal(partialRecovered.ok, true, JSON.stringify(partialRecovered));
  assert.equal((await readdir(partialInit.projectDirectory)).some(function (name) { return name.includes("stale-lock") || name.endsWith(".lock"); }), false);

  const inconsistent = await lockFixture("stale-one-sided-lock", "3");
  await mkdir(inconsistent.lockDirectory);
  await writeFile(path.join(inconsistent.lockDirectory, "lock.json"), JSON.stringify(inconsistent.lock) + "\n");
  await writeFile(path.join(inconsistent.projectDirectory, inconsistent.lock.partial_name + ".owner.json"), JSON.stringify({
    version: 1,
    owner: inconsistent.lock.owner,
    operation_id: inconsistent.lock.operation_id,
    partial_name: inconsistent.lock.partial_name,
    final_name: inconsistent.lock.final_name,
  }) + "\n");
  const oneSided = await createProjectBackup({ workspaceRoot: inconsistent.f.workspace, documentSha256: inconsistent.f.documentSha256, handoffId: inconsistent.handoffId, purpose: "safe" }, inconsistent.f.options);
  assert.equal(oneSided.error, "BACKUP_LOCK_INITIALIZATION_INCONSISTENT");
  const inconsistentEntries = await readdir(inconsistent.projectDirectory);
  assert.equal(inconsistentEntries.includes(path.basename(inconsistent.lockDirectory)), true);
  assert.equal(inconsistentEntries.some(function (name) { return name.includes("stale-lock"); }), false);
});

test("file-count, total-byte, depth, path, rename, verification, and cleanup failures stay unpublished", async function (t) {
  const cases = [
    { label: "count", setup: async (f) => writeFile(path.join(f.workspace, "extra.txt"), "x"), limits: { maxFiles: 1 }, error: "BACKUP_FILE_QUOTA_EXCEEDED" },
    { label: "total", setup: async (f) => writeFile(path.join(f.workspace, "extra.txt"), "1234567890"), limits: { maxTotalBytes: f => 1 }, error: "BACKUP_TOTAL_QUOTA_EXCEEDED" },
    { label: "depth", setup: async (f) => { await mkdir(path.join(f.workspace, "a", "b"), { recursive: true }); await writeFile(path.join(f.workspace, "a", "b", "x.txt"), "x"); }, limits: { maxDepth: 1 }, error: "BACKUP_DEPTH_QUOTA_EXCEEDED" },
    { label: "path", setup: async (f) => writeFile(path.join(f.workspace, "long-name.txt"), "x"), limits: { maxRelativePath: 8 }, error: "BACKUP_PATH_QUOTA_EXCEEDED" },
  ];
  for (const item of cases) {
    const f = await backupWorkspace(t, "quota-" + item.label);
    await item.setup(f);
    const limits = { ...item.limits };
    if (typeof limits.maxTotalBytes === "function") limits.maxTotalBytes = limits.maxTotalBytes(f);
    const result = await createProjectBackup({ workspaceRoot: f.workspace, documentSha256: f.documentSha256, purpose: "safe" }, { ...f.options, testing: true, testLimits: limits });
    assert.equal(result.error, item.error, item.label + ": " + JSON.stringify(result));
  }
  for (const failure of ["before_publish", "rename"]) {
    const f = await backupWorkspace(t, "failure-" + failure);
    const result = await createProjectBackup({ workspaceRoot: f.workspace, documentSha256: f.documentSha256, purpose: "safe" }, { ...f.options, testing: true, injectFailure: failure });
    assert.equal(result.ok, false);
    const projectName = (await readdir(f.backupRoot)).find(function (name) { return name.startsWith("project-"); });
    assert.equal((await readdir(path.join(f.backupRoot, projectName))).some(function (name) { return /^2026年/u.test(name) || name.includes("partial"); }), false);
  }
  const metadata = await backupWorkspace(t, "failure-metadata");
  const metadataResult = await createProjectBackup({ workspaceRoot: metadata.workspace, documentSha256: metadata.documentSha256, purpose: "blocked-purpose" }, {
    ...metadata.options,
    scanText(text) { return String(text).includes("blocked-purpose") ? ["HANDOFF_CAPABILITY"] : []; },
  });
  assert.equal(metadataResult.error, "BACKUP_METADATA_UNSAFE");
  const verification = await backupWorkspace(t, "failure-verification");
  let verificationChanged = false;
  const verificationResult = await createProjectBackup({ workspaceRoot: verification.workspace, documentSha256: verification.documentSha256, purpose: "safe" }, {
    ...verification.options, testing: true,
    async afterManifestRead(tree) {
      if (verificationChanged) return;
      verificationChanged = true;
      await writeFile(path.join(tree, "备份清单.json"), "{}\n");
    },
  });
  assert.equal(verificationResult.ok, false);
  const cleanup = await backupWorkspace(t, "failure-cleanup");
  const cleanupResult = await createProjectBackup({ workspaceRoot: cleanup.workspace, documentSha256: cleanup.documentSha256, purpose: "safe" }, { ...cleanup.options, testing: true, injectFailure: "before_publish", injectCleanupFailure: true });
  assert.equal(cleanupResult.error, "BACKUP_CLEANUP_FAILED");
});

test("authorized backup releases broker lock during copy and expired lease cannot commit", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400), "cccc0000-dddd-4444-8555-666666666666");
  const signal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 60_000 });
  const claim = await claimRequest(markerFromResult(signal), { ...f, now: 60_001 });
  const document = path.join(f.base, "HANDOFF.md");
  await writeFile(document, "# HANDOFF\n\nCAS state.\n");
  const scan = await scanFile(document);
  assert.equal((await checkpointState({ lease: claim.lease, next_state: "handoff_written", document_path: document, document_sha256: scan.sha256 }, { ...f, now: 60_002 })).ok, true);
  assert.equal((await checkpointState({ lease: claim.lease, next_state: "scan_passed", document_sha256: scan.sha256 }, { ...f, now: 60_003 })).ok, true);
  const options = fixtureBackupOptions(t, f, 60_004);
  let observedUnlocked = false;
  const expired = await backupAuthorized({ lease: claim.lease, document_path: document, document_sha256: scan.sha256 }, {
    ...options, testing: true, commitNow: 60_001 + 61 * 60 * 1000,
    async afterCandidateScan() {
      const states = path.join(f.codexHome, "plugin-data", "handoff-document-generator", "context-handoff-v2", "states");
      observedUnlocked = !(await readdir(states)).some(function (name) { return name.endsWith(".lock"); });
    },
  });
  assert.equal(observedUnlocked, true);
  assert.equal(expired.error, "LEASE_EXPIRED_BEFORE_BACKUP_COMMIT");
});

test("directory links, ancestor replacement, linked roots, aliases, and unsafe Unicode fail closed", async function (t) {
  const f = await backupWorkspace(t, "path-hardening");
  const outside = path.join(f.parent, "outside-dir");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "outside\n");
  try {
    await symlink(outside, path.join(f.workspace, "linked-dir"), process.platform === "win32" ? "junction" : "dir");
    const linked = await createProjectBackup({ workspaceRoot: f.workspace, documentSha256: f.documentSha256, purpose: "safe" }, f.options);
    assert.equal(linked.ok, true, JSON.stringify(linked));
    const manifest = JSON.parse(await readFile(path.join(linked.backup_path, "备份清单.json"), "utf8"));
    assert.ok(manifest.exclusions.some(function (item) { return item.rule_id === "DENY_LINK"; }));
  } catch (error) {
    assert.equal(error?.code, "EPERM", "unexpected junction setup failure");
  }
  const race = await backupWorkspace(t, "ancestor-race");
  await mkdir(path.join(race.workspace, "sub"));
  await writeFile(path.join(race.workspace, "sub", "file.txt"), "race\n");
  let replaced = false;
  const raceResult = await createProjectBackup({ workspaceRoot: race.workspace, documentSha256: race.documentSha256, purpose: "safe" }, {
    ...race.options, testing: true,
    async beforeEntryLstat(relative) {
      if (relative !== "sub/file.txt" || replaced) return;
      replaced = true;
      await rename(path.join(race.workspace, "sub"), path.join(race.workspace, "sub-moved"));
    },
  });
  assert.equal(raceResult.ok, false);
  const realRoot = path.join(f.parent, "real-root");
  const linkedRoot = path.join(f.parent, "linked-root");
  await mkdir(realRoot);
  try {
    await symlink(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(resolveBackupRoot(f.workspace, { env: { CODEX_HANDOFF_BACKUP_ROOT: linkedRoot } }), /BACKUP_ROOT_UNSAFE/);
  } catch (error) {
    assert.equal(error?.code, "EPERM", "unexpected root-link setup failure");
  }
  await assert.rejects(resolveBackupRoot(f.workspace, { env: { CODEX_HANDOFF_BACKUP_ROOT: path.join(f.workspace, "..", path.basename(f.workspace), "inside") } }), /BACKUP_ROOT_OVERLAP/);
  await assert.rejects(resolveBackupRoot(f.workspace, { env: { CODEX_HANDOFF_BACKUP_ROOT: path.join(f.parent, "bad\u202e-root") } }), /BACKUP_ROOT_UNSAFE/);
});

test("Windows backup handles safe long project paths", async function (t) {
  if (process.platform !== "win32") return t.skip("Windows-only long-path regression");
  const f = await backupWorkspace(t, "long-path-project");
  let directory = f.workspace;
  for (let index = 0; index < 7; index += 1) {
    directory = path.join(directory, `segment-${index}-` + "x".repeat(32));
  }
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, "deep-source.md");
  await writeFile(target, "# deep safe markdown\n");
  assert.ok(target.length > 260);
  const result = await backupManualRequest({ workspace_root: f.workspace, document_path: f.document, document_sha256: f.documentSha256 }, f.options);
  assert.equal(result.ok, true, JSON.stringify(result));
  const manifest = JSON.parse(await readFile(path.join(result.backup_path, "备份清单.json"), "utf8"));
  assert.ok(manifest.files.some(function (item) { return item.path.endsWith("/deep-source.md"); }));
});

test("backup implementation has no hardcoded drive and v3 receipt deletion cannot bypass backup", async function (t) {
  const backupSource = await readFile(path.join(projectRoot, "scripts", "project-backup.mjs"), "utf8");
  assert.doesNotMatch(backupSource, /[A-Za-z]:[\\/]/u);
  const f = await fixtureSession(t, tokenEvent(179792, 258400), "ffffffff-0000-4111-8222-333333333333");
  const signal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 50_000 });
  const claim = await claimRequest(markerFromResult(signal), { ...f, now: 50_001 });
  const document = path.join(f.base, "HANDOFF.md");
  await writeFile(document, "# HANDOFF\n\nLegacy state.\n");
  const scan = await scanFile(document);
  assert.equal((await checkpointState({ lease: claim.lease, next_state: "handoff_written", document_path: document, document_sha256: scan.sha256 }, { ...f, now: 50_002 })).ok, true);
  assert.equal((await checkpointState({ lease: claim.lease, next_state: "scan_passed", document_sha256: scan.sha256 }, { ...f, now: 50_003 })).ok, true);
  const options = fixtureBackupOptions(t, f, 50_004);
  assert.equal((await backupAuthorized({ lease: claim.lease, document_path: document, document_sha256: scan.sha256 }, options)).ok, true);
  assert.equal((await checkpointState({ lease: claim.lease, next_state: "creating_child", ...syntheticTaskTarget }, options)).ok, true);
  const states = path.join(f.codexHome, "plugin-data", "handoff-document-generator", "context-handoff-v2", "states");
  const stateFile = path.join(states, (await readdir(states)).find(function (name) { return name.endsWith(".json"); }));
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  for (const key of ["backup_path", "backup_root_id", "backup_manifest_sha256", "backup_checksum_sha256", "backup_document_sha256", "backup_snapshot_id", "backup_idempotency_key"]) delete state[key];
  state.lease_expires_at = 0;
  await writeFile(stateFile, JSON.stringify(state));
  const later = 50_001 + 61 * 60 * 1000;
  const resumedSignal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: later });
  const resumed = await claimRequest(markerFromResult(resumedSignal), { ...f, now: later + 1 });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.resume_stage, "claimed");
  assert.equal(resumed.backup_path, null);
});

test("genuine v2 creating_child state migrates once and completes with explicit legacy exemption", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400), "aaaa0000-bbbb-4222-8333-444444444444");
  const signal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 55_000 });
  const claim = await claimRequest(markerFromResult(signal), { ...f, now: 55_001 });
  const document = path.join(f.base, "HANDOFF.md");
  await writeFile(document, "# HANDOFF\n\nLegacy v2 state.\n");
  const scan = await scanFile(document);
  assert.equal((await checkpointState({ lease: claim.lease, next_state: "handoff_written", document_path: document, document_sha256: scan.sha256 }, { ...f, now: 55_002 })).ok, true);
  assert.equal((await checkpointState({ lease: claim.lease, next_state: "scan_passed", document_sha256: scan.sha256 }, { ...f, now: 55_003 })).ok, true);
  const options = fixtureBackupOptions(t, f, 55_004);
  assert.equal((await backupAuthorized({ lease: claim.lease, document_path: document, document_sha256: scan.sha256 }, options)).ok, true);
  assert.equal((await checkpointState({ lease: claim.lease, next_state: "creating_child", ...syntheticTaskTarget }, options)).ok, true);
  const states = path.join(f.codexHome, "plugin-data", "handoff-document-generator", "context-handoff-v2", "states");
  const stateFile = path.join(states, (await readdir(states)).find(function (name) { return name.endsWith(".json"); }));
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  state.version = 2;
  delete state.legacy_backup_exempt;
  delete state.legacy_task_target_pending;
  delete state.project_id;
  delete state.child_title;
  for (const key of ["backup_path", "backup_root_id", "backup_manifest_sha256", "backup_checksum_sha256", "backup_document_sha256", "backup_snapshot_id", "backup_idempotency_key", "backup_operation_id", "backup_operation_lease_hash", "backup_operation_started_at"]) delete state[key];
  state.lease_expires_at = 0;
  await writeFile(stateFile, JSON.stringify(state));
  const later = 55_001 + 61 * 60 * 1000;
  const resumedSignal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: later });
  const resumed = await claimRequest(markerFromResult(resumedSignal), { ...f, now: later + 1 });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.resume_stage, "creating_child");
  assert.equal(resumed.legacy_backup_exempt, true);
  assert.equal(resumed.legacy_task_target_pending, true);
  assert.equal(resumed.project_id, null);
  assert.equal(resumed.child_title, null);
  const prompt = await buildChildPrompt({ lease: resumed.lease, document_path: document, document_sha256: scan.sha256 }, { ...f, now: later + 2 });
  assert.equal(prompt.ok, true, JSON.stringify(prompt));
  assert.equal(prompt.legacy_backup, true);
  assert.equal((await checkpointState({
    lease: resumed.lease,
    next_state: "creating_child",
    project_id: resumed.lease,
    child_title: syntheticTaskTarget.child_title,
  }, { ...f, now: later + 3 })).error, "TASK_TARGET_RECEIPT_REQUIRED");
  assert.equal((await checkpointState({
    lease: resumed.lease,
    next_state: "child_created",
    child_id: resumed.lease,
    ...syntheticTaskTarget,
  }, { ...f, now: later + 3 })).error, "CHILD_ID_REQUIRED");
  for (const checkpoint of [
    { next_state: "child_created", child_id: "legacy-child", ...syntheticTaskTarget },
    { next_state: "title_set" },
    { next_state: "child_opened" },
    { next_state: "complete" },
  ]) assert.equal((await checkpointState({ lease: resumed.lease, ...checkpoint }, { ...f, now: later + 3 })).ok, true);
  const migrated = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(migrated.version, 3);
  assert.equal(migrated.legacy_backup_exempt, true);
  assert.equal(migrated.legacy_task_target_pending, false);
  assert.equal(migrated.project_id, syntheticTaskTarget.project_id);
  assert.equal(migrated.child_title, syntheticTaskTarget.child_title);
});

test("unlocked v2 readers cannot overwrite a newer locked v3 checkpoint", async function (t) {
  const f = await fixtureSession(t, tokenEvent(179792, 258400), "bbbb1111-cccc-4333-8444-555555555555");
  const signal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: 57_000 });
  const claim = await claimRequest(markerFromResult(signal), { ...f, now: 57_001 });
  const document = path.join(f.base, "HANDOFF.md");
  await writeFile(document, "# HANDOFF\n\nMigration interleave.\n");
  const scan = await scanFile(document);
  assert.equal((await checkpointState({ lease: claim.lease, next_state: "handoff_written", document_path: document, document_sha256: scan.sha256 }, { ...f, now: 57_002 })).ok, true);
  assert.equal((await checkpointState({ lease: claim.lease, next_state: "scan_passed", document_sha256: scan.sha256 }, { ...f, now: 57_003 })).ok, true);
  const options = fixtureBackupOptions(t, f, 57_004);
  assert.equal((await backupAuthorized({ lease: claim.lease, document_path: document, document_sha256: scan.sha256 }, options)).ok, true);
  assert.equal((await checkpointState({ lease: claim.lease, next_state: "creating_child", ...syntheticTaskTarget }, options)).ok, true);
  const states = path.join(f.codexHome, "plugin-data", "handoff-document-generator", "context-handoff-v2", "states");
  const stateFile = path.join(states, (await readdir(states)).find(function (name) { return name.endsWith(".json"); }));
  const legacy = JSON.parse(await readFile(stateFile, "utf8"));
  legacy.version = 2;
  delete legacy.legacy_backup_exempt;
  delete legacy.legacy_task_target_pending;
  delete legacy.project_id;
  delete legacy.child_title;
  for (const key of ["backup_path", "backup_root_id", "backup_manifest_sha256", "backup_checksum_sha256", "backup_document_sha256", "backup_snapshot_id", "backup_idempotency_key", "backup_operation_id", "backup_operation_lease_hash", "backup_operation_started_at"]) delete legacy[key];
  await writeFile(stateFile, JSON.stringify(legacy));

  let observedResolve;
  let resumeResolve;
  const observed = new Promise(function (resolve) { observedResolve = resolve; });
  const resume = new Promise(function (resolve) { resumeResolve = resolve; });
  let paused = false;
  const reader = buildChildPrompt({ lease: claim.lease, document_path: document, document_sha256: scan.sha256 }, {
    ...options,
    testing: true,
    async afterUnlockedStateRead(snapshot) {
      if (!snapshot.migrated || paused) return;
      paused = true;
      observedResolve();
      await resume;
    },
  });
  await observed;
  const advanced = await checkpointState({
    lease: claim.lease,
    next_state: "child_created",
    child_id: "newer-v3-child",
    ...syntheticTaskTarget,
  }, options);
  assert.equal(advanced.ok, true, JSON.stringify(advanced));
  resumeResolve();
  assert.equal((await reader).ok, true);
  const finalState = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(finalState.version, 3);
  assert.equal(finalState.legacy_backup_exempt, true);
  assert.equal(finalState.stage, "child_created");
  assert.equal(finalState.child_id, "newer-v3-child");
});

test("title normalization removes Cc/Cf and long titles advance without duplicate suffixes", function () {
  assert.equal(normalizeTaskTitle("<b>任\u200B务</b>\n一"), "任 务 一");
  const base = "很长的任务".repeat(30);
  const one = nextContinuationTitle(base, [], 40);
  const two = nextContinuationTitle(base, [one], 40);
  assert.match(one, /（续接 1）$/);
  assert.match(two, /（续接 2）$/);
  let titles = [];
  let current = base;
  for (let index = 1; index <= 10; index += 1) {
    current = nextContinuationTitle(base, titles, 40);
    titles.push(current);
  }
  assert.match(current, /（续接 10）$/);
  assert.ok(Array.from(current).length <= 40);
});

test("tail reader drops one partial leading record", async function (t) {
  const f = await fixtureSession(t, tokenEvent(1, 258400));
  const valid = tokenEvent(179792, 258400);
  await writeFile(f.transcript, "x".repeat(4096) + "\n" + valid + "\n{");
  const tail = await readTailText(f.transcript, Buffer.byteLength(valid) + 20);
  assert.equal(tail.includes("x".repeat(20)), false);
  assert.deepEqual(extractLatestStructuredUsage(tail), {
    used: 179792,
    total: 258400,
    source: "rollout_token_count",
  });
});

test("cleanup retires stale state and caps records at 100", async function (t) {
  await mkdir(workRoot, { recursive: true });
  const base = await mkdtemp(path.join(workRoot, "test-clean-"));
  t.after(async function () { await rm(base, { recursive: true, force: true }); });
  const directory = path.join(
    base,
    "plugin-data",
    "handoff-document-generator",
    "context-handoff-v2",
    "states",
  );
  await mkdir(directory, { recursive: true });
  const now = 2_000_000_000_000;
  for (let index = 0; index < 105; index += 1) {
    const hash = createHash("sha256").update("synthetic-" + index).digest("hex");
    await writeFile(path.join(directory, hash + ".json"), JSON.stringify({
      version: 2,
      session_hash: hash,
      stage: "complete",
      retire_at: index === 0 ? now - 1 : now + 100_000,
    }));
  }
  await cleanupPluginState(base, now);
  const remaining = (await readdir(directory)).filter(function (name) { return name.endsWith(".json"); });
  assert.equal(remaining.length, 100);
});

test("state cleanup preserves replacements and repeatedly converges to exactly 100 records", async function (t) {
  await mkdir(workRoot, { recursive: true });
  const base = await mkdtemp(path.join(workRoot, "test-state-clean-"));
  t.after(async function () { await rm(base, { recursive: true, force: true }); });
  const now = 2_000_000_000_000;
  await cleanupPluginState(base, now);
  const states = path.join(base, "plugin-data", "handoff-document-generator", "context-handoff-v2", "states");
  let replacedFile = null;
  for (let index = 0; index < 105; index += 1) {
    const hash = createHash("sha256").update("state-clean-" + index).digest("hex");
    const file = path.join(states, hash + ".json");
    await writeFile(file, JSON.stringify({ version: 3, retire_at: now + 100_000, sequence: index }));
    await utimes(file, new Date(now - (105 - index) * 1000), new Date(now - (105 - index) * 1000));
    if (index === 0) replacedFile = file;
  }
  let replaced = false;
  await cleanupPluginState(base, now, {
    testing: true,
    async beforeStateRecordRetire(item) {
      if (replaced || item !== replacedFile) return;
      replaced = true;
      await writeFile(item, JSON.stringify({ version: 3, retire_at: now + 200_000, replacement: true }));
      await utimes(item, new Date(now + 500_000), new Date(now + 500_000));
    },
  });
  assert.equal(replaced, true);
  assert.equal(JSON.parse(await readFile(replacedFile, "utf8")).replacement, true);
  assert.equal((await readdir(states)).filter(function (name) { return /^[a-f0-9]{64}\.json$/u.test(name); }).length, 100);

  for (let round = 0; round < 12; round += 1) {
    for (let index = 0; index < 7; index += 1) {
      const hash = createHash("sha256").update(`state-stress-${round}-${index}`).digest("hex");
      await writeFile(path.join(states, hash + ".json"), JSON.stringify({
        version: 3,
        retire_at: now + 300_000,
        round,
        index,
      }));
    }
    await cleanupPluginState(base, now);
    assert.equal((await readdir(states)).filter(function (name) { return /^[a-f0-9]{64}\.json$/u.test(name); }).length, 100);
  }
  assert.equal((await readdir(states)).some(function (name) { return name.includes(".cleanup-"); }), false);
});

test("broker cleanup preserves replacements and repeatedly converges to exactly 100 records", async function (t) {
  await mkdir(workRoot, { recursive: true });
  const base = await mkdtemp(path.join(workRoot, "test-broker-clean-"));
  t.after(async function () { await rm(base, { recursive: true, force: true }); });
  const now = Date.now();
  await cleanupBrokerState(base, now);
  const requests = path.join(base, "plugin-data", "handoff-document-generator", "context-handoff-v2", "requests");
  let replacedFile = null;
  for (let index = 0; index < 105; index += 1) {
    const hash = createHash("sha256").update("broker-clean-" + index).digest("hex");
    const file = path.join(requests, hash + ".json");
    await writeFile(file, JSON.stringify({ version: 2, expires_at: now + 100_000, sequence: index }));
    await utimes(file, new Date(now - (105 - index) * 1000), new Date(now - (105 - index) * 1000));
    if (index === 0) replacedFile = file;
  }
  let replaced = false;
  await cleanupBrokerState(base, now, {
    testing: true,
    async beforeBrokerRecordRetire(item) {
      if (replaced || item !== replacedFile) return;
      replaced = true;
      await writeFile(item, JSON.stringify({ version: 2, expires_at: now + 200_000, replacement: true }));
    },
  });
  assert.equal(replaced, true);
  assert.equal(JSON.parse(await readFile(replacedFile, "utf8")).replacement, true);
  assert.equal((await readdir(requests)).filter(function (name) { return /^[a-f0-9]{64}\.json$/u.test(name); }).length, 100);

  for (let round = 0; round < 12; round += 1) {
    for (let index = 0; index < 7; index += 1) {
      const hash = createHash("sha256").update(`broker-stress-${round}-${index}`).digest("hex");
      await writeFile(path.join(requests, hash + ".json"), JSON.stringify({ version: 2, expires_at: now + 300_000, round, index }));
    }
    await cleanupBrokerState(base, now);
    assert.equal((await readdir(requests)).filter(function (name) { return /^[a-f0-9]{64}\.json$/u.test(name); }).length, 100);
  }
  assert.equal((await readdir(requests)).some(function (name) { return name.includes(".cleanup-"); }), false);
});

test("Windows Hook command treats a hostile PLUGIN_ROOT value as data", async function (t) {
  if (process.platform !== "win32") return t.skip("Windows-only shell quoting regression");
  const candidates = [
    process.env.SHELL,
    process.env.SystemRoot && path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  ].filter(Boolean);
  let shell = null;
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && await lstat(candidate).then(function (info) { return info.isFile(); }, function () { return false; })) {
      shell = candidate;
      break;
    }
  }
  if (!shell) return t.skip("absolute PowerShell unavailable");
  await mkdir(workRoot, { recursive: true });
  const pluginRoot = await mkdtemp(path.join(workRoot, "test-hook-$() & '-"));
  t.after(async function () { await rm(pluginRoot, { recursive: true, force: true }); });
  const scripts = path.join(pluginRoot, "scripts");
  await mkdir(scripts);
  await writeFile(
    path.join(scripts, "context-handoff.mjs"),
    "if (process.argv[2] !== 'hook') process.exitCode = 2; else process.stdout.write('HOOK_OK');\n",
  );
  const hooks = JSON.parse(await readFile(path.join(projectRoot, "hooks", "hooks.json"), "utf8"));
  const command = hooks.hooks.PreToolUse[0].hooks[0].commandWindows;
  const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    env: { ...process.env, PLUGIN_ROOT: pluginRoot },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "HOOK_OK");
});

test("manifest, hooks, and manuals preserve compatibility and safe matchers", async function () {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, ".codex-plugin", "plugin.json"), "utf8"));
  assert.match(manifest.version, /^0\.4\.0(?:\+codex\.[0-9A-Za-z.-]+)?$/);
  assert.equal(Object.hasOwn(manifest, "hooks"), false);
  const hooks = JSON.parse(await readFile(path.join(projectRoot, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks.hooks), [
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "PreCompact",
    "PostCompact",
  ]);
  assert.equal(hooks.hooks.PreCompact[0].matcher, "^auto$");
  assert.equal(hooks.hooks.PostCompact[0].matcher, "^auto$");
  const handlers = Object.values(hooks.hooks).flatMap(function (groups) {
    return groups.flatMap(function (group) { return group.hooks; });
  });
  assert.equal(handlers.length, 5);
  for (const handler of handlers) {
    assert.equal(handler.command, 'node "$PLUGIN_ROOT/scripts/context-handoff.mjs" hook');
    assert.equal(handler.commandWindows, 'node "$env:PLUGIN_ROOT/scripts/context-handoff.mjs" hook');
    assert.doesNotMatch(handler.commandWindows, /Windows\\System32|-Command/);
  }
  const skill = await readFile(path.join(projectRoot, "skills", "generate-handoff-document", "SKILL.md"), "utf8");
  const english = await readFile(path.join(projectRoot, "commands", "handoff.md"), "utf8");
  const chinese = await readFile(path.join(projectRoot, "commands", "交接文档.md"), "utf8");
  assert.match(skill, /\/handoff/);
  assert.match(skill, /\/交接文档/);
  assert.match(skill, /natural-language/);
  assert.match(english, /Manual mode/);
  assert.match(chinese, /手动模式/);
  assert.doesNotMatch(skill, /AUTO_HANDOFF_REQUEST/);
  assert.match(skill, /\["node","<plugin-root>\/scripts\/context-handoff\.mjs","scan"\]/);
  assert.match(skill, /\["node","<plugin-root>\/scripts\/context-handoff\.mjs","backup"\]/);
  assert.match(skill, /\["node","<plugin-root>\/scripts\/context-handoff\.mjs","backup-authorized"\]/);
  assert.match(skill, /scan_passed → backup_created → creating_child/);
  assert.match(skill, /"workspace_root":"<absolute workspace root>"/);
  assert.doesNotMatch(skill, /scan\s+"<absolute-HANDOFF-path>"/);
});

test("golden HANDOFF preserves one H1 plus fourteen ordered H2 headings", async function () {
  const golden = await readFile(new URL("HANDOFF.golden.md", fixtureRoot), "utf8");
  const headings = golden.match(/^#{1,2} .+$/gm);
  assert.equal(headings.length, 15);
  assert.equal(headings[0], "# HANDOFF");
  const skill = await readFile(path.join(projectRoot, "skills", "generate-handoff-document", "SKILL.md"), "utf8");
  let cursor = -1;
  for (const heading of headings) {
    const next = skill.indexOf(heading, cursor + 1);
    assert.ok(next > cursor, "skill must preserve " + heading);
    cursor = next;
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  LOCK_TTL_MS,
  acquireLock,
  buildChildPrompt,
  checkpointState,
  claimRequest,
  cleanupPluginState,
  contextGuardTokens,
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
  scanFile,
  scanFileAuthorized,
  scanManualRequest,
  scanSecrets,
  validateTranscriptPath,
} from "../scripts/context-handoff.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = path.join(projectRoot, "work");
const fixtureRoot = new URL("./fixtures/", import.meta.url);

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
  const childPrompt = await buildChildPrompt({
    lease: claim.lease,
    document_path: document,
    document_sha256: scan.sha256,
  }, { ...f, now: 10_004 });
  assert.equal(childPrompt.ok, true);
  assert.match(childPrompt.prompt, /^Read HANDOFF\.md first and continue the project\./);
  assert.match(childPrompt.prompt, new RegExp(claim.handoff_id));
  assert.match(childPrompt.prompt, /Open it once, hash the exact bytes you read, and stop unless/);
  assert.match(childPrompt.prompt, /SHA-256 exactly matches/);
  assert.doesNotMatch(childPrompt.prompt, new RegExp(claim.lease));
  for (const input of [
    { next_state: "creating_child" },
    { next_state: "child_created", child_id: "child-123" },
    { next_state: "title_set" },
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
  await writeFile(document, "# HANDOFF\n\nMutated after receipt.\n");
  const prompt = await buildChildPrompt({
    lease: claim.lease,
    document_path: document,
    document_sha256: scan.sha256,
  }, { ...f, now: 17_004 });
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
    { next_state: "creating_child" },
  ]) {
    assert.equal((await checkpointState({ lease: claim.lease, ...input }, { ...f, now: 1002 })).ok, true);
  }
  const later = 1001 + 61 * 60 * 1000;
  const resumedSignal = await handleHookEvent(hookInput(f, "Stop"), { ...f, now: later });
  const resumed = await claimRequest(markerFromResult(resumedSignal), { ...f, now: later + 1 });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resume_stage, "creating_child");
  assert.equal(resumed.handoff_id, claim.handoff_id);
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

test("Windows Hook command treats a hostile PLUGIN_ROOT value as data", async function (t) {
  if (process.platform !== "win32") return t.skip("Windows-only shell quoting regression");
  const shell = process.env.SHELL;
  if (!shell || !path.isAbsolute(shell)) return t.skip("absolute PowerShell unavailable");
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
  assert.match(manifest.version, /^0\.3\.0(?:\+codex\.[0-9A-Za-z.-]+)?$/);
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

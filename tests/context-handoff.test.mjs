import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  checkpointState,
  cleanupPluginState,
  extractLatestStructuredUsage,
  handleHookEvent,
  isAtContextThreshold,
  nextContinuationTitle,
  normalizeTaskTitle,
  parseUiContextStatus,
  readTailText,
  scanSecrets,
  validateTranscriptPath,
} from "../scripts/context-handoff.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = new URL("./fixtures/", import.meta.url);

function line(value) {
  return JSON.stringify(value);
}

function sessionMeta(id) {
  return line({ type: "session_meta", payload: { id } });
}

function tokenEvent(used, total, cumulative = 9_999_999) {
  return line({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        model_context_window: total,
        last_token_usage: { input_tokens: used },
        total_token_usage: { input_tokens: cumulative },
      },
    },
  });
}

async function fixtureSession(t, id = "11111111-2222-4333-8444-555555555555", body = "") {
  const base = await mkdtemp(path.join(os.tmpdir(), "handoff-hook-"));
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

test("98 percent boundary uses integer arithmetic", function () {
  assert.equal(isAtContextThreshold(253231, 258400), false);
  assert.equal(isAtContextThreshold(253232, 258400), true);
});

test("latest valid structured value wins and cumulative totals are ignored", function () {
  const text = [
    tokenEvent(253232, 258400, 1),
    "{malformed",
    tokenEvent(59000, 258400, 999999999),
    "{\"type\":\"event_msg\",\"payload\":",
  ].join("\n");
  assert.deepEqual(extractLatestStructuredUsage(text), {
    used: 59000,
    total: 258400,
    source: "rollout_token_count",
  });
});

test("explicit Chinese and English UI text preserves used/remaining semantics", function () {
  assert.deepEqual(parseUiContextStatus("背景信息窗口：\n23% 已用（剩余 77%）\n已用 59k 标记，共 258k"), {
    source: "explicit_ui_text",
    usedPercent: 23,
    remainingPercent: 77,
    usedTokens: 59000,
    totalTokens: 258000,
  });
  const english = parseUiContextStatus("Context window: 77% remaining; 59k tokens used, total 258k tokens");
  assert.equal(english.usedPercent, 23);
  assert.equal(english.remainingPercent, 77);
  assert.equal(english.usedTokens, 59000);
  assert.equal(english.totalTokens, 258000);
});

test("transcript must be a matching regular file under CODEX_HOME sessions", async function (t) {
  const f = await fixtureSession(t, undefined, tokenEvent(1, 100));
  assert.equal(await validateTranscriptPath({
    transcriptPath: f.transcript,
    sessionId: f.id,
    codexHome: f.codexHome,
  }), await realpath(f.transcript));
  const outside = path.join(f.base, "outside-" + f.id + ".jsonl");
  await writeFile(outside, sessionMeta(f.id));
  assert.equal(await validateTranscriptPath({
    transcriptPath: outside,
    sessionId: f.id,
    codexHome: f.codexHome,
  }), null);
  assert.equal(await validateTranscriptPath({
    transcriptPath: f.transcript,
    sessionId: "different-session-id",
    codexHome: f.codexHome,
  }), null);
  const linked = path.join(path.dirname(f.transcript), "linked-" + f.id + ".jsonl");
  try {
    await symlink(f.transcript, linked);
    assert.equal(await validateTranscriptPath({
      transcriptPath: linked,
      sessionId: f.id,
      codexHome: f.codexHome,
    }), null);
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  }
});

test("Stop blocks once at exact threshold and stop_hook_active always passes", async function (t) {
  const f = await fixtureSession(t, undefined, tokenEvent(253232, 258400));
  const input = {
    hook_event_name: "Stop",
    session_id: f.id,
    transcript_path: f.transcript,
    stop_hook_active: false,
  };
  const first = await handleHookEvent(input, f);
  assert.equal(first.decision, "block");
  assert.match(first.reason, /AUTO_HANDOFF_REQUEST/);
  assert.match(first.reason, /trigger=exact_98/);
  assert.match(first.reason, /used=253232 window=258400/);
  assert.equal(await handleHookEvent(input, f), null);
  assert.equal(await handleHookEvent({ ...input, stop_hook_active: true }, f), null);
});

test("PreCompact blocks once, then Stop requests an honest fallback", async function (t) {
  const f = await fixtureSession(t, undefined, tokenEvent(202262, 258400));
  const pre = {
    hook_event_name: "PreCompact",
    session_id: f.id,
    transcript_path: f.transcript,
  };
  assert.deepEqual(await handleHookEvent(pre, f), { continue: false });
  assert.equal(await handleHookEvent(pre, f), null);
  const stop = await handleHookEvent({ ...pre, hook_event_name: "Stop" }, f);
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /trigger=precompact/);
  assert.doesNotMatch(stop.reason, /trigger=exact_98/);
});

test("concurrent Stop calls create one atomic request", async function (t) {
  const f = await fixtureSession(t, undefined, tokenEvent(253232, 258400));
  const input = { hook_event_name: "Stop", session_id: f.id, transcript_path: f.transcript };
  const results = await Promise.all(Array.from({ length: 12 }, function () {
    return handleHookEvent(input, f);
  }));
  assert.equal(results.filter(function (value) { return value?.decision === "block"; }).length, 1);
});

test("expired requests recover once and stop after two attempts", async function (t) {
  const f = await fixtureSession(t, undefined, tokenEvent(253232, 258400));
  const input = { hook_event_name: "Stop", session_id: f.id, transcript_path: f.transcript };
  const first = await handleHookEvent(input, { ...f, now: 1000 });
  assert.equal(first.decision, "block");
  const second = await handleHookEvent(input, { ...f, now: 1000 + 31 * 60 * 1000 });
  assert.equal(second.decision, "block");
  assert.notEqual(second.reason, first.reason);
  assert.equal(await handleHookEvent(input, { ...f, now: 1000 + 62 * 60 * 1000 }), null);
});

test("checkpoint transitions are ordered and child id is stored only as a hash", async function (t) {
  const f = await fixtureSession(t, undefined, tokenEvent(253232, 258400));
  const request = await handleHookEvent({
    hook_event_name: "Stop",
    session_id: f.id,
    transcript_path: f.transcript,
  }, f);
  const nonce = request.reason.match(/nonce=([^\s]+)/)[1];
  assert.deepEqual(await checkpointState({
    session_id: f.id,
    nonce,
    next_state: "handoff_written",
  }, f), { ok: true, state: "handoff_written" });
  assert.equal((await checkpointState({
    session_id: f.id,
    nonce,
    next_state: "child_created",
    child_id: "child-raw-id",
  }, f)).ok, false);
  await checkpointState({ session_id: f.id, nonce, next_state: "scan_passed" }, f);
  await checkpointState({
    session_id: f.id,
    nonce,
    next_state: "child_created",
    child_id: "child-raw-id",
  }, f);
  const stateFiles = await readdir(path.join(f.pluginData, "context-handoff-v1"));
  const stateText = await readFile(path.join(f.pluginData, "context-handoff-v1", stateFiles.find(function (name) {
    return name.endsWith(".json");
  })), "utf8");
  assert.doesNotMatch(stateText, /child-raw-id/);
  assert.doesNotMatch(stateText, new RegExp(f.id));
});

test("title normalization removes controls and tags and increments same-base sequence", function () {
  assert.equal(normalizeTaskTitle("<b>任务</b>\n一"), "任务 一");
  assert.equal(nextContinuationTitle("任务", ["任务（续接 1）", "其他（续接 9）", "任务（续接 3）"]), "任务（续接 4）");
  assert.equal(nextContinuationTitle("任务（续接 4）", []), "任务（续接 5）");
  assert.ok(nextContinuationTitle("x".repeat(200), [], 30).length <= 30);
});

test("secret scanner returns only rule identifiers and line numbers", function () {
  const secret = "OPENAI_API_KEY=sk-" + "A".repeat(32);
  const userinfoUrl = "https://" + "synthetic-user" + ":" + "synthetic-password" + "@example.invalid/a";
  const findings = scanSecrets(["safe", secret, userinfoUrl].join("\n"));
  assert.deepEqual(findings.map(function (item) { return item.ruleId; }).sort(), [
    "ENV_SECRET_ASSIGNMENT",
    "TOKEN_PREFIX",
    "URL_USERINFO",
  ]);
  assert.equal(JSON.stringify(findings).includes("AAAA"), false);
  assert.deepEqual(scanSecrets("OPENAI_API_KEY=<redacted>\nTOKEN=${TOKEN}"), []);
});

test("checked-in UI and rollout fixtures are synthetic and deterministic", async function () {
  const chinese = await readFile(new URL("ui-status-zh.txt", fixtureRoot), "utf8");
  const english = await readFile(new URL("ui-status-en.txt", fixtureRoot), "utf8");
  assert.equal(parseUiContextStatus(chinese).usedPercent, 23);
  assert.equal(parseUiContextStatus(english).remainingPercent, 77);
  const rollout = await readFile(new URL("rollout.synthetic.txt", fixtureRoot), "utf8");
  assert.deepEqual(extractLatestStructuredUsage(rollout), {
    used: 253232,
    total: 258400,
    source: "rollout_token_count",
  });
});

test("tail reader drops a partial leading record and tolerates a partial trailing record", async function (t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "handoff-tail-"));
  t.after(async function () {
    await rm(base, { recursive: true, force: true });
  });
  const file = path.join(base, "tail.txt");
  const valid = tokenEvent(253232, 258400);
  await writeFile(file, "x".repeat(4096) + "\n" + valid + "\n{\"type\":");
  const tail = await readTailText(file, Buffer.byteLength(valid) + 20);
  assert.equal(tail.includes("x".repeat(20)), false);
  assert.deepEqual(extractLatestStructuredUsage(tail), {
    used: 253232,
    total: 258400,
    source: "rollout_token_count",
  });
});

test("unknown transcript schema fails open without creating state", async function (t) {
  const f = await fixtureSession(t, undefined, line({ type: "event_msg", payload: { type: "future_schema" } }));
  assert.equal(await handleHookEvent({
    hook_event_name: "Stop",
    session_id: f.id,
    transcript_path: f.transcript,
  }, f), null);
  const directory = path.join(f.pluginData, "context-handoff-v1");
  const entries = await readdir(directory).catch(function () { return []; });
  assert.equal(entries.some(function (name) { return name.endsWith(".json"); }), false);
});

test("session header mismatch is rejected even when the filename matches", async function (t) {
  const f = await fixtureSession(t, undefined, tokenEvent(253232, 258400));
  await writeFile(f.transcript, sessionMeta("different-session-header") + "\n" + tokenEvent(253232, 258400));
  assert.equal(await validateTranscriptPath({
    transcriptPath: f.transcript,
    sessionId: f.id,
    codexHome: f.codexHome,
  }), null);
});

test("checkpoint reaches complete and duplicate child creation cannot be substituted", async function (t) {
  const f = await fixtureSession(t, undefined, tokenEvent(253232, 258400));
  const request = await handleHookEvent({
    hook_event_name: "Stop",
    session_id: f.id,
    transcript_path: f.transcript,
  }, f);
  const nonce = request.reason.match(/nonce=([^\s]+)/)[1];
  for (const next_state of ["handoff_written", "scan_passed"]) {
    assert.equal((await checkpointState({ session_id: f.id, nonce, next_state }, f)).ok, true);
  }
  assert.equal((await checkpointState({
    session_id: f.id,
    nonce,
    next_state: "child_created",
    child_id: "child-one",
  }, f)).ok, true);
  assert.deepEqual(await checkpointState({
    session_id: f.id,
    nonce,
    next_state: "child_created",
    child_id: "child-two",
  }, f), { ok: false, error: "CHILD_ALREADY_RECORDED" });
  assert.equal((await checkpointState({ session_id: f.id, nonce, next_state: "title_set" }, f)).ok, true);
  assert.deepEqual(await checkpointState({ session_id: f.id, nonce, next_state: "complete" }, f), {
    ok: true,
    state: "complete",
  });
  assert.equal(await handleHookEvent({
    hook_event_name: "Stop",
    session_id: f.id,
    transcript_path: f.transcript,
  }, f), null);
});

test("state cleanup enforces retirement and 100-record cap", async function (t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "handoff-clean-"));
  t.after(async function () {
    await rm(base, { recursive: true, force: true });
  });
  const directory = path.join(base, "context-handoff-v1");
  await mkdir(directory, { recursive: true });
  const now = 2_000_000_000_000;
  for (let index = 0; index < 105; index += 1) {
    const hash = createHash("sha256").update("synthetic-" + index).digest("hex");
    await writeFile(path.join(directory, hash + ".json"), JSON.stringify({
      version: 1,
      session_hash: hash,
      retire_at: index === 0 ? now - 1 : now + 100_000,
    }));
  }
  await cleanupPluginState(base, now);
  const remaining = (await readdir(directory)).filter(function (name) {
    return name.endsWith(".json");
  });
  assert.equal(remaining.length, 100);
});

test("scan CLI blocks secrets without echoing them", async function (t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "handoff-scan-"));
  t.after(async function () {
    await rm(base, { recursive: true, force: true });
  });
  const target = path.join(base, "HANDOFF.md");
  const secret = "ghp_" + "Z".repeat(40);
  await writeFile(target, "TOKEN=" + secret);
  await assert.rejects(
    execFile(process.execPath, [path.join(projectRoot, "scripts", "context-handoff.mjs"), "scan", target]),
    function (error) {
      assert.equal(error.code, 2);
      assert.equal(error.stdout.includes(secret), false);
      const output = JSON.parse(error.stdout);
      assert.equal(output.ok, false);
      assert.ok(output.findings.every(function (finding) {
        return Object.keys(finding).sort().join(",") === "line,ruleId";
      }));
      return true;
    },
  );
});

test("golden HANDOFF preserves one H1 plus fourteen ordered H2 headings", async function () {
  const golden = await readFile(new URL("HANDOFF.golden.md", fixtureRoot), "utf8");
  const headings = golden.match(/^#{1,2} .+$/gm);
  assert.equal(headings.length, 15);
  assert.equal(headings[0], "# HANDOFF");
  assert.deepEqual(headings.slice(1), [
    "## PROJECT OVERVIEW",
    "## CLIENT / USER CONTEXT",
    "## CURRENT STATUS",
    "## APPROVED DECISIONS",
    "## DESIGN SYSTEM (IF APPLICABLE)",
    "## TECHNICAL ARCHITECTURE",
    "## FILE STRUCTURE",
    "## KNOWN ISSUES",
    "## OPEN TASKS",
    "## NEXT RECOMMENDED ACTIONS",
    "## DO NOT DO",
    "## IMPORTANT CONVERSATION INSIGHTS",
    "## PROJECT MEMORY SNAPSHOT",
    "## FINAL INSTRUCTION",
  ]);
  for (const relative of ["commands/handoff.md", "skills/generate-handoff-document/SKILL.md"]) {
    const document = await readFile(path.join(projectRoot, relative), "utf8");
    let cursor = -1;
    for (const heading of headings) {
      const next = document.indexOf(heading, cursor + 1);
      assert.ok(next > cursor, relative + " must preserve " + heading);
      cursor = next;
    }
  }
});

test("manifest omits nonstandard hooks field and plugin hooks coexist with Ralph", async function () {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.version, "0.2.0");
  assert.equal(Object.hasOwn(manifest, "hooks"), false);
  const hooksText = await readFile(path.join(projectRoot, "hooks", "hooks.json"), "utf8");
  const hooks = JSON.parse(hooksText);
  assert.ok(hooks.hooks.Stop);
  assert.ok(hooks.hooks.PreCompact);
  assert.ok(hooksText.includes("${PLUGIN_ROOT}/scripts/context-handoff.mjs"));
  assert.doesNotMatch(hooksText, /ralph/iu);
});

test("manual commands and natural-language trigger remain compatible", async function () {
  const skill = await readFile(path.join(projectRoot, "skills", "generate-handoff-document", "SKILL.md"), "utf8");
  const englishCommand = await readFile(path.join(projectRoot, "commands", "handoff.md"), "utf8");
  const chineseCommand = await readFile(path.join(projectRoot, "commands", "交接文档.md"), "utf8");
  assert.match(skill, /\/handoff/);
  assert.match(skill, /\/交接文档/);
  assert.match(skill, /natural-language/);
  assert.match(englishCommand, /Manual mode/);
  assert.match(chineseCommand, /手动入口/);
});

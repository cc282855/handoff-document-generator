---
description: Generate HANDOFF.md and prepare a new Codex continuation conversation.
argument-hint: [optional project notes]
---

# Generate Handoff Document

The user invoked `/handoff`, asked for a handoff in natural language, or this command was entered by the `AUTO_HANDOFF_REQUEST` continuation marker.

## Modes

- **Manual mode:** `/handoff`, `/交接文档`, or a natural-language request. This mode must work even when plugin hooks are disabled or untrusted.
- **Automatic mode:** only when the current continuation prompt contains a valid `AUTO_HANDOFF_REQUEST` marker with `session_id`, `nonce`, `trigger`, `used`, and `window`. Treat `trigger=precompact` as a compression fallback; never claim it reached 98%.

## Goal

Create a file named `HANDOFF.md` in the current workspace so a completely new AI instance can continue the project without reading prior chat history. Then prepare a new Codex conversation that starts from the generated handoff content.

## Required Behavior

1. Inspect the current workspace before writing:
   - Identify the project type, important files, existing assets, and current state.
   - Prefer `rg --files`, `git status --short`, package manifests, README files, docs, and project config.
   - If this is a projectless chat or no meaningful project files exist, still create a handoff focused on conversation context and local Codex/plugin state.
   - Never read or copy `auth.json`, values from `.env*`, cookies, credentials, tokens, private keys, raw transcript/JSONL, hidden reasoning, Codex logs, SQLite databases, or screenshots.
2. Create `HANDOFF.md` at the workspace root with an atomic same-directory write (or `apply_patch` when that is the available atomic editor).
3. Use the exact structure required in this command. Keep the document comprehensive and detailed enough for another AI six months from now.
4. Run the deterministic scanner before creating a task:
   - Execute `node "<plugin-root>/scripts/context-handoff.mjs" scan "<absolute-HANDOFF-path>"`.
   - A non-empty finding list blocks task creation. Report only rule IDs and line numbers; never echo a matched value.
   - After a clean scan, compute the file SHA-256.
5. Prepare a clean Codex task using this exact tool order when tools exist:
   - `list_projects`, then `list_threads` to identify the source title and existing sequence.
   - `create_thread`. Never use `fork_thread`.
   - `set_thread_title` to `<sanitized source title>（续接 N）`, where N is one greater than the largest same-base sequence.
   - `read_thread` to verify the child task and initial prompt.
   - Optionally `navigate_to_codex_page` only after verification.
   - Use a registered project only when its canonical path matches the active workspace; otherwise use a projectless target.
6. The child task's initial prompt must start with this exact first line:

   `Read HANDOFF.md first and continue the project.`

   Include the absolute HANDOFF path, its SHA-256, the source `session_id`/nonce in automatic mode, and the complete scanned HANDOFF content when it fits the tool input.
7. In automatic mode, advance the nonce-protected checkpoint through `handoff_written`, `scan_passed`, `child_created`, `title_set`, and `complete`. Pass the raw child ID only to the `child_created` checkpoint; the runtime stores only its hash.
8. If task-management tools are missing or any create/title/readback step is unverified, do not claim success. Report the exact HANDOFF path and stop; never create a duplicate child after `child_created` has been recorded.

## Important Limitation

Codex plugin commands cannot reliably click the native Codex UI or attach local files into the composer. Prefer Codex task tools when available. If unavailable, do not fake UI automation, attachment, title, navigation, or task-creation success.

## HANDOFF.md Structure

Use this structure exactly:

```markdown
# HANDOFF

## PROJECT OVERVIEW

* Project name
* Project purpose
* Business goal
* Current project stage
* Definition of success

## CLIENT / USER CONTEXT

* Who the client is
* Target audience
* Industry
* Relevant business context
* Important preferences
* Important constraints

## CURRENT STATUS

* Finished tasks
* Approved decisions
* Completed deliverables
* Existing assets

## APPROVED DECISIONS

* Design decisions
* Technical decisions
* Product decisions
* Naming decisions
* Branding decisions

## DESIGN SYSTEM (IF APPLICABLE)

### Typography

* Fonts
* Sizes
* Hierarchy

### Colors

* Primary colors
* Secondary colors
* Accent colors

### Spacing

* Section spacing
* Layout width

### Components

* Buttons
* Cards
* Forms
* Navigation

### Photography

* Style
* Mood
* Rules

## TECHNICAL ARCHITECTURE

* Platform
* Framework
* CMS
* Hosting
* APIs
* Integrations

## FILE STRUCTURE

List important files and directories and explain their purpose.

## KNOWN ISSUES

* Bugs
* Technical limitations
* Missing permissions
* Platform constraints
* Risks

## OPEN TASKS

Organize by priority.

## NEXT RECOMMENDED ACTIONS

Provide a clear step-by-step plan.

## DO NOT DO

List things future AI instances must avoid.

## IMPORTANT CONVERSATION INSIGHTS

Summarize key discoveries and rationale.

## PROJECT MEMORY SNAPSHOT

Create a concise summary readable in under two minutes.

## FINAL INSTRUCTION

Write this document as if another AI will continue the project six months from now with zero access to previous chats.

Nothing important should be missing.
```

## Writing Standards

- Be specific. Prefer exact paths, commands, decisions, and dates over vague summaries.
- Distinguish confirmed facts from assumptions.
- Include known limitations and blocked items.
- Do not invent business context that is not present. Mark unknowns explicitly.
- Save the final output as `HANDOFF.md`.
- Do not include raw Hook input, rollout records, state files, hidden reasoning, or secrets in the document.

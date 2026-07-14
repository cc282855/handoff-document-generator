---
name: generate-handoff-document
description: Generate a comprehensive HANDOFF.md for transferring the current project to a new AI conversation, especially when the user says /交接文档, /handoff, 交接文档, handoff, or asks to continue work in a new conversation with full project memory.
---

# Generate Handoff Document

Use this skill when the user wants a project handoff document, invokes `/交接文档` or `/handoff`, asks in natural language to continue in a new conversation, or a Stop continuation prompt contains `AUTO_HANDOFF_REQUEST`.

## Objective

Create `HANDOFF.md` in the active workspace so a new AI instance can continue without reading prior chat history. The file must be comprehensive, concrete, useful months later, and safe to place in a new task.

## Choose the Mode

### Manual mode

Use manual mode for `/handoff`, `/交接文档`, and natural-language requests. It is independent of hooks and must keep working when hooks are disabled, untrusted, or fail open.

### Automatic mode

Use automatic mode only when the current continuation prompt contains all of:

```text
AUTO_HANDOFF_REQUEST session_id=<id> nonce=<nonce> trigger=<exact_98|precompact> used=<value> window=<value>
```

Do not obtain these fields from command arguments, environment variables, a title search, or transcript content. `trigger=exact_98` means the structured counter reached the threshold. `trigger=precompact` is an honest native-compaction fallback and must never be described as reaching 98%.

## Mandatory Safety Boundary

Inspect only ordinary project source, documentation, manifests, configuration schemas, Git metadata, and user-approved assets. Never open, summarize, embed, hash for disclosure, or copy:

- `auth.json` or authentication stores;
- values from `.env` or `.env.*`;
- cookies, access tokens, API keys, credentials, private keys, or secret stores;
- raw Codex transcripts/rollout JSONL, hidden reasoning, local logs, SQLite databases, or screenshots.

Mention excluded sources only as excluded categories. Do not put Hook stdin, runtime state JSON, nonce-bearing output, or local Codex background data into HANDOFF.md.

## Workflow

1. Inspect local context within the safety boundary:
   - Run `rg --files` where available.
   - Read README, package manifests, app configs, docs, and important source entry points when present.
   - Check `git status --short` when the workspace is a git repo.
   - Include projectless conversation facts when no code project exists.
2. Write `HANDOFF.md` at the workspace root atomically. Prefer `apply_patch` when it is the available atomic editor; otherwise write a same-directory temporary file and atomically rename it. Never leave a partial final file.
3. Preserve the structure below exactly.
4. In automatic mode, checkpoint `handoff_written` only after the final file exists. Invoke the plugin runtime's `checkpoint` CLI with a small stdin JSON object containing only `session_id`, `nonce`, and `next_state`.
5. Run the deterministic scan CLI before any task creation:

   `node "<plugin-root>/scripts/context-handoff.mjs" scan "<absolute-HANDOFF-path>"`

   If it reports findings, stop. Report only each rule ID and line number; do not quote the matching line or value. In automatic mode, do not advance beyond `handoff_written`.
6. After a clean scan, compute the exact file SHA-256. In automatic mode, checkpoint `scan_passed`.
7. If Codex task-management tools are callable, use this order:
   1. `list_projects` to find a registered project whose canonical path is the active workspace. If none matches, choose a projectless target.
   2. `list_threads` to find the source task by exact `session_id` in automatic mode and to inspect existing continuation titles.
   3. Sanitize the source title: remove controls, tags, and newlines, collapse spaces, and cap length. Strip an existing terminal `（续接 N）`. Choose one greater than the largest sequence with the same base.
   4. `create_thread` to create a clean task. Never call `fork_thread`, because a fork copies the old context.
   5. In automatic mode, immediately checkpoint `child_created` with the returned child ID. The runtime stores only its SHA-256. If this checkpoint already exists, never create another child.
   6. `set_thread_title` to `<base>（续接 N）`, then checkpoint `title_set` in automatic mode.
   7. `read_thread` and verify that the returned child ID, title, and first prompt correspond to this handoff.
   8. Checkpoint `complete` only after readback succeeds. Optionally call `navigate_to_codex_page` after completion when available.
8. The child prompt's exact first line is:

   `Read HANDOFF.md first and continue the project.`

   Then include the absolute HANDOFF path, the SHA-256, the automatic source `session_id` and nonce when applicable, and the complete scanned file content when it fits the tool input. The file path alone is not an excuse to omit content when the content fits.
9. If `create_thread`, title, or readback tools are unavailable or fail, report the exact saved path and the failed verified step. Never claim that a task, title, attachment, navigation, or UI action succeeded without tool evidence.

## UI Automation Constraint

Do not claim to have clicked the Codex UI or imported an attachment unless an authorized tool performed it successfully. Do not use desktop automation to scrape the background-information window. Codex plugin commands are instruction files; they cannot by themselves click native UI controls.

## Required HANDOFF.md Structure

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

## Quality Bar

- Use exact paths, dates, commands, package names, and decisions when known.
- Mark unknowns as unknown.
- Separate confirmed facts from assumptions.
- Keep the file useful even if the next AI has no tool output from this conversation.
- Preserve the main heading and all 14 H2 headings in the exact order above.
- Mark facts, inferences, unknowns, blockers, and unfinished verification distinctly.
- Run the scanner again after any edit made in response to a finding.

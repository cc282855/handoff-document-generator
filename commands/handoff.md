---
description: Generate HANDOFF.md and prepare a new Codex continuation conversation.
argument-hint: [optional project notes]
---

# Generate Handoff Document

The user invoked `/handoff`.

## Goal

Create a file named `HANDOFF.md` in the current workspace so a completely new AI instance can continue the project without reading prior chat history. Then prepare a new Codex conversation that starts from the generated handoff content.

## Required Behavior

1. Inspect the current workspace before writing:
   - Identify the project type, important files, existing assets, and current state.
   - Prefer `rg --files`, `git status --short`, package manifests, README files, docs, and project config.
   - If this is a projectless chat or no meaningful project files exist, still create a handoff focused on conversation context and local Codex/plugin state.
2. Create `HANDOFF.md` at the workspace root.
3. Use the exact structure required in this command. Keep the document comprehensive and detailed enough for another AI six months from now.
4. After saving `HANDOFF.md`, create a new Codex conversation when the `create_thread` tool is available:
   - Use a project target when a saved project is clearly available.
   - Otherwise use a projectless target.
   - Initial prompt must include: `Read HANDOFF.md first and continue the project.`
   - Include either the full HANDOFF.md content or a clear absolute path to the generated file.
5. If the current environment cannot create a new Codex conversation or attach/import the file automatically, say that clearly and provide the exact generated file path.

## Important Limitation

Codex plugin commands cannot reliably click the native Codex UI or attach local files into the composer. Prefer the Codex thread tool when available. If it is unavailable, do not fake UI automation success.

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

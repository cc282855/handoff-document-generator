---
name: generate-handoff-document
description: Generate a comprehensive HANDOFF.md for transferring the current project to a new AI conversation, especially when the user says /交接文档, /handoff, 交接文档, handoff, or asks to continue work in a new conversation with full project memory.
---

# Generate Handoff Document

Use this skill when the user wants a project handoff document or invokes `/交接文档` or `/handoff`.

## Objective

Create `HANDOFF.md` in the active workspace so a new AI instance can continue without reading prior chat history. The file must be comprehensive, concrete, and useful months later.

## Workflow

1. Inspect local context:
   - Run `rg --files` where available.
   - Read README, package manifests, app configs, docs, and important source entry points when present.
   - Check `git status --short` when the workspace is a git repo.
   - Include projectless conversation facts when no code project exists.
2. Write `HANDOFF.md` at the workspace root.
3. Preserve the structure below exactly.
4. If Codex thread management tools are available, create a new Codex thread whose initial prompt says:
   - `Read HANDOFF.md first and continue the project.`
   - Include the absolute path to `HANDOFF.md`.
   - Include the full handoff content when practical.
5. If a tool for creating a new thread is not available, report the saved path and tell the user the file is ready for a new conversation.

## UI Automation Constraint

Do not claim to have clicked the Codex UI or imported an attachment unless an actual UI/browser/computer-use tool performed it successfully. Codex plugin commands are instruction files; they cannot by themselves click native UI controls.

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

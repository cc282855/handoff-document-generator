---
description: Generate HANDOFF.md and continue in a clean, consecutively titled Codex task.
argument-hint: [optional project notes]
---

# Generate Handoff Document

Use the installed generate-handoff-document skill in manual mode. The user explicitly requested a handoff, so:

1. Inspect only safe project material and atomically create HANDOFF.md at the workspace root using the skill's exact 14-section structure.
2. Run the plugin's handle-based secret scanner and retain its returned SHA-256.
3. Before creating any task, run the plugin's `backup` command with workspace root, HANDOFF path, and scanner SHA-256 through bounded standard-input JSON. Require a verified backup receipt; never let prompt input choose the backup root. Stop if backup creation, quota enforcement, or final verification fails.
4. List Codex projects and run the skill's `project-target` validation. Continue only with the one registered local project whose canonical path exactly equals the workspace. Never fall back to a projectless, remote, similarly named, parent, or child project. Stop with the returned registration error before task creation when no unique match exists.
5. Create a clean task in that verified local project, never a fork. Its first prompt must tell the task to verify the backup and read HANDOFF.md. Include only the HANDOFF absolute path and SHA-256, a non-sensitive handoff_id, the validated single-line backup receipt ID, and the skill's fixed safety instructions. Never inject the raw backup path into the task prompt.
6. Derive a concise Chinese base title that preserves the visible source task's meaning, then append （续接 N）, where N advances existing same-base tasks. If the source title is already Chinese, preserve it after sanitization.
7. Read the new task back, open that exact task with the Codex navigation tool, and only then claim that backup, creation, renaming, or navigation succeeded.

Manual mode must not require a Hook marker, request, claim, lease, transcript, or UI background text. Never paste the full HANDOFF, secrets, source session data, or runtime state into the child prompt.

If backup or task tools are unavailable, report the exact HANDOFF.md path, backup path when available, and the verified incomplete stage.

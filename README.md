# Handoff Document Generator

Codex plugin for generating a detailed `HANDOFF.md` and preparing a continuation conversation.

## What It Does

- Adds `/handoff` and `/交接文档` commands.
- Creates a comprehensive `HANDOFF.md` in the current workspace.
- Captures project overview, current status, technical architecture, known issues, open tasks, and next actions.
- Uses Codex thread tools when available to prepare a new conversation that can continue from the handoff.

## Plugin Structure

```text
.codex-plugin/plugin.json
commands/handoff.md
commands/交接文档.md
skills/generate-handoff-document/SKILL.md
```

## Installation

Install this plugin through Codex as a local or GitHub plugin source, then invoke either command:

```text
/handoff
/交接文档
```

## Notes

The plugin does not pretend to click native UI controls or attach local files unless a real Codex tool performs that action successfully.

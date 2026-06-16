---
name: data-oriented-workflow
description: Data-oriented nagent-style workflow for Pi. Use when work must survive restarts, span multiple turns, require plans/checkpoints/campaigns, or when the user asks for nagent-like behavior in Pi.
---

# Data-Oriented Workflow for Pi

Use Pi's native session, tool-call, compaction, and branching features. Do not emulate nagent XML tags.

## Rules

1. Treat the Pi JSONL session as durable state, but put project-relevant memory in explicit files.
2. Store durable work under `.pi/artifacts/data-agent/` unless the project already has a better documented location.
3. For non-trivial work, maintain one of:
   - `.pi/artifacts/data-agent/checkpoints/*.md`
   - `.pi/artifacts/data-agent/campaigns/<slug>/campaign.md`
   - `.pi/artifacts/data-agent/knowledge/*.md`
   - a project-owned plan/decision document.
4. Automatic maintenance exports transcripts after runs and checkpoints large/old deltas; Pi's native compaction should use data-oriented summary instructions when the extension is loaded.
5. Before changing behavior, inspect real files and tests. State what was verified.
6. When output is wrong, fix the prompt/generator/input when possible; do not silently patch generated artifacts and leave the cause intact.

## Commands supplied by the extension

```text
/data-status
/data-artifacts
/data-checkpoint [name]
/data-distill
/data-compact [extra instructions]
/data-campaign list
/data-campaign new <slug> <goal>
/data-campaign status <slug>
/data-campaign add <slug> <item>
```

## Typical flow

1. `/data-status` to inspect current durable state.
2. `/data-campaign new <slug> <goal>` for long work, or `/data-checkpoint <name>` before risky changes.
3. Use Pi tools normally (`read`, `edit`, `bash`); do not use nagent XML tags.
4. `/data-distill` after meaningful progress to harvest facts, decisions, file notes, commands, and questions.
5. `/data-artifacts` or `/data-checkpoint` before stopping.

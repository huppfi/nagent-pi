# nagent-pi

Nagent-style, data-oriented workflow resources for [Pi](https://github.com/badlogic/pi-mono): a Pi extension, skill, and prompt template that keep important agent state in explicit project-local files.

The goal is **Pi runtime + nagent artifact discipline**:

- use Pi's native JSONL sessions, tool calls, compaction, branches, skills, prompts, and command system
- do **not** reimplement nagent XML tags or a separate provider loop
- write durable, inspectable state under `.pi/artifacts/data-agent/`

## What it adds

Global/project commands:

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

Also included:

```text
/skill:data-oriented-workflow
/data-start goal="..."
```

Automatic behavior when the extension is loaded:

- adds short data-oriented design operating rules (`.pi/nagent-context/data-oriented-design.md`), including a hard no-runtime-allocation rule, as a `data_oriented_design` prompt section. See [`.pi/nagent-context/README.md`](.pi/nagent-context/README.md)
- adds a `data_oriented_workflow` section to Pi's structured system prompt
- exports a Markdown transcript after agent runs, appending only new entries (it is rewritten in full only after a branch switch or an outside edit)
- writes automatic restart checkpoints after large/old branch deltas
- makes Pi's normal compaction use data-oriented/nagent-style summary instructions
- guards risky writes and shell commands for protected paths/destructive operations (see [Guard](#guard))

Artifact files are written atomically (temp file, then rename), and files whose content didn't change are not rewritten. A state file that exists but can't be read or parsed is reported and left alone, never reset.

## Guard

The guard catches common accidents. It is **not a security boundary**: it matches command text against a deny list, so anything it doesn't recognize (`eval`, a script, an interpreter one-liner) runs without asking.

- `write`/`edit` to `.git/`, `node_modules/`, `.env` or `~/.ssh/` is blocked.
- These bash commands ask first (and are blocked in non-interactive mode): recursive `rm` (with or without `-f`: the agent's shell has no terminal, so `rm -r` never prompts), `find -delete` / `-exec rm`, `git reset --hard`, `git clean -f`, `git checkout -- …` / `.` / `-f`, `git restore` (without `--staged`), `git stash drop|clear`, `git branch -D`, `git push --force` / `+ref`, `dd of=`, `mkfs` / `wipefs` / `shred`, `sudo`, and shell redirection or `tee` into `.env`, `.git/` or `.ssh/`.
- Exception: `rm`, `find` and local git commands run without asking when every target (or the folder git runs in) is strictly inside a real temp root (`os.tmpdir()`, `$TMPDIR`, `/tmp`, `/var/tmp`), after resolving `..` and symlinks. A folder that is merely *named* like one (`~/project-temp`) does not count. Pipes, subshells, command substitution, background jobs, `pushd`, `git -C` and unexpanded variables other than the temp ones always ask.

## Install as a Pi package (recommended)

```bash
pi install git:github.com/huppfi/nagent-pi
```

Add `-l` to install for the current project only. `pi update --extensions` pulls new versions. For development, install a local checkout instead; Pi loads it in place without copying:

```bash
pi install /path/to/nagent-pi
```

Use either the package or the copy scripts below, not both.

## Install globally by copying

```bash
git clone https://github.com/huppfi/nagent-pi.git
cd nagent-pi
./install-global.sh
```

Then in Pi:

```text
/reload
/data-status
```

## Install into one project

```bash
git clone https://github.com/huppfi/nagent-pi.git
cd /path/to/project
/path/to/nagent-pi/install-project.sh
```

Then trust/reload project resources if Pi prompts you:

```text
/reload
/data-status
```

## Starting a new project after global install

```bash
cd /path/to/project
pi
```

Inside Pi:

```text
/data-status
/data-start goal="Build/investigate/refactor ..."
```

For longer work:

```text
/data-campaign new my-task Describe the goal here
```

During work:

```text
/data-checkpoint name
/data-distill
/data-artifacts
```

Pi's normal `/compact` and auto-compaction keep Pi's default trigger behavior, but use data-oriented summary instructions from this extension. Use `/data-compact` only when you want to force compaction now with extra guidance.

## Artifact layout

Generated per project:

```text
.pi/artifacts/data-agent/
  README.md
  sessions/<session-id>/transcript.md
  sessions/<session-id>/files.md
  checkpoints/*.md
  campaigns/<slug>/campaign.md
  knowledge/*.md
  state/<session-id>.json
```

These files are intentionally inspectable and editable. Commit them only when they are useful project knowledge; otherwise keep them local.

The extension creates `.pi/artifacts/data-agent/.gitignore` (once, without overwriting) that excludes `sessions/`, `checkpoints/`, and `state/`, because transcripts and branch tails can contain secrets from tool output. Campaigns and knowledge files stay committable. Edit that file to change the policy.

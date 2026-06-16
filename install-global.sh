#!/usr/bin/env bash
set -euo pipefail

src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="${PI_AGENT_DIR:-$HOME/.pi/agent}"

mkdir -p "$agent_dir/extensions" "$agent_dir/skills" "$agent_dir/prompts"
cp "$src_dir/.pi/extensions/data-oriented-agent.ts" "$agent_dir/extensions/data-oriented-agent.ts"
rm -rf "$agent_dir/skills/data-oriented-workflow"
cp -R "$src_dir/.pi/skills/data-oriented-workflow" "$agent_dir/skills/data-oriented-workflow"
cp "$src_dir/.pi/prompts/data-start.md" "$agent_dir/prompts/data-start.md"

cat <<MSG
Installed nagent-pi resources to $agent_dir

In Pi, run:
  /reload
  /data-status
MSG

#!/usr/bin/env bash
set -euo pipefail

src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${1:-$PWD}"

mkdir -p "$target_dir/.pi/extensions" "$target_dir/.pi/skills" "$target_dir/.pi/prompts"
cp "$src_dir/.pi/extensions/data-oriented-agent.ts" "$target_dir/.pi/extensions/data-oriented-agent.ts"
rm -rf "$target_dir/.pi/skills/data-oriented-workflow"
cp -R "$src_dir/.pi/skills/data-oriented-workflow" "$target_dir/.pi/skills/data-oriented-workflow"
cp "$src_dir/.pi/prompts/data-start.md" "$target_dir/.pi/prompts/data-start.md"
rm -rf "$target_dir/.pi/nagent-context"
cp -R "$src_dir/.pi/nagent-context" "$target_dir/.pi/nagent-context"

cat <<MSG
Installed nagent-pi resources to $target_dir/.pi

In Pi, trust/reload project resources if prompted, then run:
  /reload
  /data-status
MSG

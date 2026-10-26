# Operating rules

`data-oriented-design.md` is a short data-oriented design rule set (after Mike Acton), plus one
hard rule: no runtime memory allocation in languages that control allocation; static storage
only, with one sized-at-startup allocation allowed when the input decides a size and nothing
bounds it. The extension injects the file into every run as the `data_oriented_design` prompt
section.

It replaces a longer adaptation of [`macton/nagent` `context/data-oriented-design.md`](https://github.com/macton/nagent/blob/main/context/data-oriented-design.md)
(MIT): 12.3k characters inline plus 3.4k of software rules read on demand. The benchmarks in
`bench/` up to 2026-10-26 used that version; it is kept in `bench/rules-v1/`. Kept from it:
the input/output and constraint questions, "can we not do this at all", batches, layout by
access, explicit out-of-range behaviour, no speculative generality, no unmeasured performance
claims, and scaling the ceremony to the task. Dropped: tiers, the method checklist, the nine
simplification questions, the self-check, data protocols, the tier 2 deliverables and `issues/`.

Edit the file to change the rules. The extension reads it once at load, so run `/reload` after
editing. If the file is missing, the extension warns and runs without the rules; the guards and
artifacts are unaffected.

## Cost

3.3k characters. First model call of the smallest harm-task run, prompt tokens with
`claude-opus-5-5` through `pi-claude-bridge` (2026-10-26): vanilla Pi 3,187; the extension
with the old rules 7,567; with these rules 4,586 (the rules plus the workflow section, ~1.4k
over vanilla). The section is constant, so it stays cached. Do not interpolate per-session
values into it.

## Check (2026-10-26, run v2-d / v2-h, Pi + extension)

| | old rules (d-pi / h-pi) | these rules |
|---|---|---|
| lru heap calls, perf input | 20 | 6 (3/3 allocate once at startup, comment says why) |
| emitters design | 3/3 skip dead particles | 3/3 skip dead particles, 2/3 no allocation at all |
| harm tasks correct (strict) | 8/10 | 5/5 (1 per task) |
| cost, emitters / lru median | 137k / 121k | 97k / 74k |

Timings are not compared: the runs were timed in separate passes. 3 programs per design task
and 1 per harm task: directions, not rates.

## Check: edits follow the rules (2026-10-26, run v3-edit, 3 programs)

Prompt: change the drones' damping in the seeded `legacy.c` from 0.99 to 0.98. The edited line
allocated a new vector on every tick. All 3 programs: output identical to a plain constant
swap, and the touched line now scales in place with no allocation. 1 of 3 also converted
`move()`, which the same tick calls. None converted `entity_new` (drone spawning) or the
linked list, which would mean redesigning the program. All 3 replies listed the extra change and
why. Diffs were 5 to 15 lines.

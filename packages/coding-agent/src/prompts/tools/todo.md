{{#if dag}}
`todo` NEVER takes a turn of its own: emit it in the same response as your next real tool call (parallel tool calls), `init` beside the first read or action, `start`/`done` beside the next action or check.
DAG mode is active: tasks form a dependency DAG with short IDs (`t1`, `t2`, ...) assigned by the tool. Reference tasks by `id` (or exact `content`).
Initialize once with `init` using `nodes: [{ id?, content, phase?, deps? }]` (or `list`/`items`). Each node's `deps` lists prerequisite IDs that must finish before it can start.
After every completion or edit, the tool runs topological sort and lists **Ready** tasks (all prerequisites satisfied) and **Blocked** tasks (unmet prerequisites). You choose which ready task(s) to `start` next (`id` or `ids`); multiple independent ready tasks may run concurrently. `start` and `done` reject blocked tasks.
Mid-flight DAG edits require a concrete `reason`:
- `insert`: add a node (`content`, optional `phase`, `after`/`deps`, `before`/`blocks`, `reason`). When both `after` and `before` are given, `before` targets rewire `after -> new -> before`.
- `append`: add nodes (`items`, optional `phase`, `after`/`deps`, `before`/`blocks`, `reason`).
- `update`: modify `content`, `phase`, or `deps` / `addDeps` / `removeDeps` (`reason` required; cycles rejected).
- `drop`: mark one open task abandoned (`id`/`task`, `reason` required).
- `rm`: remove one open task (`id`/`task`, `reason` required; bridges its prerequisites onto its dependents).
Do NOT re-run `init` while open tasks exist, and do NOT bulk-delete or drop tasks to evade unfinished work.
{{else}}
`todo` NEVER takes a turn of its own: emit it in the same response as your next real tool call (parallel tool calls), `init` beside the first read or action, `done`/`start` beside the next action or check. A response whose only call is `todo` wastes a full model round trip.
Tasks identified by verbatim content, NEVER generated IDs (task-1). Unique, stable task/phase names; lost text: view, NEVER guess.
`append` requires `items`; omitted `phase` uses the in-progress task's phase, else the first pending task's phase, else the last phase, else a new `Tasks` phase. Supply `phase` to target another phase; an empty name is invalid.
Before work, init for 3+ steps, requested task sets, or new instructions. MUST list EVERY user item separately (phased/numbered/bulleted/N); NEVER omit or remember leftovers.
After successful mutation: no active means earliest pending starts (phase order); multiple active means only earliest stays. Done out of order may rewind pointer but NEVER reopen completed. Mark done immediately; follow phase order.
{{/if}}

# <Project> — agent operating manual

<2–4 sentences: what the product does, stack, languages, any legal must-haves.>
This file is a router, not a manual: it defines the session loop and the invariants and links to
the detail. The repository, not the chat, is the system of record.

## Clock-in (session start)

Before touching code:

1. `pwd` — confirm you are in the repository root.
2. Read [PROGRESS.md](PROGRESS.md) — Current Verified State and Next Steps.
3. `pnpm harness:feature next --include-manual`, then `pnpm harness:feature show F-NNN`; read its spec before coding.
4. `git log --oneline -5` — what changed most recently.
5. `./init.sh` — installs, checks tooling and runs the L1 baseline (`FAST=1` skips it).
6. If the baseline is red, fix that first. Never stack feature work on a broken start.
7. `pnpm harness:feature activate F-NNN` (WIP=1, dependency check) and work only on it.

Claude Code: `/harness:clock-in` runs these steps; the session-start hook prints the state summary.

## Verification layers

| Layer | Command                 | Covers | Needs   |
| ----- | ----------------------- | ------ | ------- |
| L1    | `pnpm check`            | …      | nothing |
| L2    | `pnpm test:integration` | …      | …       |
| L3    | `pnpm test:e2e`         | …      | …       |

- Layers run in order. Do not proceed to layer N+1 while layer N fails, and do not skip a layer a feature lists.
- The repository is in a consistent state when `pnpm check` exits 0.
- `pnpm harness:verify F-NNN` runs a feature's layers in order and records evidence; `manual:` steps fail closed. `pnpm harness:clean-state` is the machine-checkable clock-out gate.

## Constraints

Each rule carries a `why:` so it can be revisited when the reason disappears.

- MUST use `pnpm`. why: lockfile + `packageManager` pin. source: package.json.
- MUST NOT `.skip`/`.only` tests, weaken assertions or lower coverage thresholds to get green. why: verification is the completion gate.
- MUST update docs affected by a change in the same commit. why: stale docs mislead the next session more than no docs.
- MUST make one logical change per commit, with a conventional-commit subject and a body that explains why. why: the history is read at every clock-in.
- <project constraints: MUST … why: … source: …>

## Working rules

- WIP=1: only one feature may be `in_progress`. Finish it (`passing`) or mark it `blocked` with a note before activating the next.
- State machine: `not_started → in_progress → passing`, or `→ blocked` with the reason in `notes`. Change status only through `pnpm harness:feature` / `pnpm harness:verify`.
- Dependencies live in `depends_on`; a feature is ready when every dependency is `passing`.
- Granularity: a feature must be completable in one session. If it cannot, split it in `feature_list.json` before starting.
- Scope: stay inside the selected feature; a narrow supporting fix is fine, a second feature is not.
- Completion means evidence, not confidence: `YYYY-MM-DD <command> → pass (commit <hash>)` in `evidence`.
- Context anxiety: if you are running low on context, stop, update `PROGRESS.md`, commit a clean checkpoint, and leave the next step written down.
- Escalate instead of guessing: unclear requirements → the feature's `spec`, then ask. In a driver-run session (`HARNESS_LOOP=1`) nobody can answer: pick the simplest reading, record it, or block the feature.

## Definition of done

A feature is done only when all of these are true:

- [ ] The `user_visible_behavior` is implemented.
- [ ] Every listed verification layer actually ran, in order, and passed.
- [ ] Evidence is recorded in `feature_list.json` and the status is `passing`.
- [ ] `PROGRESS.md` is updated (Current Verified State, session entry, Next Steps).
- [ ] Affected docs are updated in the same commit.
- [ ] The tree is committed and clean, and `FAST=1 ./init.sh` still exits 0.

## Clock-out (session end)

1. `pnpm harness:clean-state --allow-state-dirty`, then the judgement items of [docs/harness/clean-state-checklist.md](docs/harness/clean-state-checklist.md).
2. Update `PROGRESS.md`; `feature_list.json` is already updated by `pnpm harness:verify` (or `pnpm harness:feature block`).
3. `pnpm check` (plus the feature's L2/L3).
4. Optional: score the diff with [docs/harness/evaluator-rubric.md](docs/harness/evaluator-rubric.md) (Claude Code: the `harness:evaluator` agent). Revise before committing if any category is below 2.
5. Commit; for long sessions also fill [docs/harness/session-handoff.md](docs/harness/session-handoff.md).
6. Leave a clean restart path: the next session must be able to run `./init.sh` immediately.

Claude Code: `/harness:clock-out` walks these steps; `/harness:verify-feature F-NNN` runs a feature's layers and records evidence.

## Driver-run sessions

`pnpm harness:loop` runs the same loop unattended: one fresh session per ready feature in its own
worktree, `pnpm harness:verify` as the gate, a fresh-context evaluator, then a PR. Inside such a
session `HARNESS_LOOP=1` is set, questions cannot be asked, `manual:` steps are never waived and the
driver (not the session) pushes. The harness itself: https://github.com/Eemelinen/harness.

## State artefacts and further reading

- State: [PROGRESS.md](PROGRESS.md) · [feature_list.json](feature_list.json) · [docs/DECISIONS.md](docs/DECISIONS.md) · [docs/harness/](docs/harness/).
- Harness configuration: [harness.config.json](harness.config.json).

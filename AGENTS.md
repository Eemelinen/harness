# Harness — agent operating manual

`@eemelinen/harness` is the shared agent harness: a TypeScript CLI (`src/`, run through `tsx`, no
build step) and a Claude Code plugin (`plugin/`: skills, the evaluator agent, guard, session-start,
format and Stop hooks) that several projects pin by release tag. This repository is also a harness
project: its own loop builds the fixes that retros in those projects file as `harness-retro` issues
([docs/self-improvement.md](docs/self-improvement.md)). This file is a router: the session loop and
the invariants, with links to the detail.

## Clock-in (session start)

1. `pwd` — confirm you are in the repository (or feature worktree) root.
2. Read [PROGRESS.md](PROGRESS.md) — Current Verified State and Next Steps.
3. `pnpm harness:feature next`, then `pnpm harness:feature show F-NNN`. A feature from a retro issue
   carries the issue's problem, evidence and proposed fix in its `notes`; read them before coding.
4. `git log --oneline -5` — what changed most recently.
5. `./init.sh` — installs, checks wiring and runs the L1 baseline (`FAST=1` skips it).
6. If the baseline is red, fix that first. Never stack feature work on a broken start.
7. `pnpm harness:feature activate F-NNN` (WIP=1, dependency check) and work only on it.

Claude Code: `/harness:clock-in` runs these steps.

## Verification layers

| Layer | Command      | Covers                                                                                        | Needs   |
| ----- | ------------ | --------------------------------------------------------------------------------------------- | ------- |
| L1    | `pnpm check` | `tsc --noEmit`, Prettier, `harness check` on this repository's feature list, the Vitest suite | nothing |

There is no L2 or L3: the CLI and the hooks are tested with unit tests against temporary
directories and git repositories (`tests/`). A behaviour change without a test is not done.

`pnpm harness:verify F-NNN` runs a feature's layers and records evidence;
`pnpm harness:clean-state` is the clock-out gate.

## Constraints

- MUST keep `plugin/hooks/*.mjs` dependency-free (Node built-ins and `./` files only). why: they run
  from Claude Code's plugin cache, which has no `node_modules`. source: docs/developing.md.
- MUST run `pnpm schema` after changing `src/config.ts` and commit the regenerated
  `schema/harness.config.schema.json`. why: projects validate their config against it, and a test
  fails while it is stale.
- MUST NOT bump `version`, edit `CHANGELOG.md` or tag. why: the release workflow does that after
  the merge, from the commit subjects (docs/developing.md → Releasing).
- MUST mark a breaking change (a config key removed or renamed, a changed CLI flag) with `!` in the
  commit subject (`feat(F-012)!: …`). why: it decides the version bump, and projects with
  `update.auto` take only non-breaking releases on their own. Config schema breaks are detected
  anyway; feature-list and CLI changes are not.
- MUST NOT start `harness loop` or `harness retro`, or call `claude` or `gh`. why: they start
  sessions, push and file issues; the driver does that.
- MUST keep changes backward compatible for pinned projects: a new config key has a default that
  keeps today's behaviour. why: every key a project does not set must keep working after an upgrade.
- MUST update the docs a change affects (`README.md`, `docs/*.md`, comments at the top of each
  module) in the same commit. why: projects adopt the harness from these docs.
- MUST use `pnpm`, never `.skip`/`.only` tests or weaken assertions to get green, and make one
  logical change per commit with a conventional-commit subject and a body that explains why.

Your session runs the plugin of the checkout the driver runs from, not the files you edit: a change
to the guard or the hooks takes effect after it merges and the driver restarts.

## Working rules

- WIP=1: only one feature may be `in_progress`. Finish it (`passing`) or mark it `blocked` with a note.
- Status changes only through `pnpm harness:feature` / `pnpm harness:verify`.
- Scope: stay inside the selected feature. A retro feature fixes the problem its notes describe; if
  the proposed fix turns out wrong, fix the problem the right way and say why in `PROGRESS.md`. If it
  cannot be fixed safely in one session, block the feature with the reason.
- Completion means evidence: `YYYY-MM-DD <command> → pass (commit <hash>)` in `evidence`.
- In a driver-run session (`HARNESS_LOOP=1`) nobody can answer questions: pick the simplest reading,
  record it, or block the feature.

## Definition of done

- [ ] The `user_visible_behavior` is implemented and covered by tests.
- [ ] `pnpm check` passed, through `pnpm harness:verify F-NNN`, and the status is `passing`.
- [ ] `PROGRESS.md` is updated (Current Verified State, session entry, Next Steps).
- [ ] Affected docs are updated in the same commit.
- [ ] The tree is committed and clean, and `FAST=1 ./init.sh` still exits 0.

## Clock-out (session end)

1. `pnpm harness:clean-state --allow-state-dirty`, then the judgement items of
   [docs/harness/clean-state-checklist.md](docs/harness/clean-state-checklist.md).
2. Update `PROGRESS.md`; `feature_list.json` is already updated by `pnpm harness:verify`.
3. `pnpm check`.
4. Commit. Leave a clean restart path: the next session must be able to run `./init.sh` at once.

Claude Code: `/harness:clock-out`; `/harness:verify-feature F-NNN`.

## Driver-run sessions

`pnpm harness:loop` runs this loop unattended, one worktree and PR per feature. With
`retro.intake`, open `harness-retro` issues become features first; their PR closes the issue. A PR
that changes a `reviewPaths` file in [harness.config.json](harness.config.json) (the guard, hooks,
agents, prompts, config, loop, retro, CI) waits for a human instead of auto-merging.

## State artefacts and further reading

- State: [PROGRESS.md](PROGRESS.md) · [feature_list.json](feature_list.json) · [docs/harness/](docs/harness/).
- How the harness works: [docs/how-it-works.md](docs/how-it-works.md) · configuration:
  [docs/config.md](docs/config.md) · developing and releasing: [docs/developing.md](docs/developing.md).

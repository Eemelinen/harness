# Agent harness

The harness lets a coding agent work on a repository one feature at a time without drifting, and
lets a driver run those sessions unattended, one pull request per feature. It is the single source
of truth for every project that uses it: improve it here, tag a release, bump the pin in each
project.

It ships two ways, always used together and pinned to the same tag:

| Shipped as                                                         | Contains                                                                                                                                                    | Installed by                                                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **npm package** `@eemelinen/harness` (CLI `harness`)               | Feature-list schema and state machine, `verify`, `clean-state`, the loop driver, `doctor`, prompts, the config schema                                       | `"@eemelinen/harness": "github:Eemelinen/harness#vX.Y.Z"` in the project's `devDependencies` |
| **Claude Code plugin** `harness` (marketplace `eemelinen-harness`) | Skills `/harness:clock-in`, `/harness:verify-feature`, `/harness:clock-out`; the `harness:evaluator` agent; the guard, session-start, format and Stop hooks | `extraKnownMarketplaces` + `enabledPlugins` in the project's `.claude/settings.json`         |

Driver-run sessions do not depend on the marketplace: the loop passes `--plugin-dir` pointing at the
plugin inside the installed package, so unattended sessions always run the plugin version that
matches the package. `pnpm harness:doctor` fails when the two pins differ.

## What lives where

| In this repository (shared)                                  | In each project (owned by the project)                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/` — the CLI                                             | `harness.config.json` — every project-specific value: ticket format, guard rules, clean-state checks, layers, services, models, caps |
| `plugin/` — skills, evaluator agent, hooks                   | `feature_list.json`, `PROGRESS.md` — the queue and the session log                                                                   |
| `prompts/` — generator and evaluator prompts, verdict schema | `AGENTS.md`, `CLAUDE.md` — the operating manual and its constraints                                                                  |
| `schema/` — JSON schema for `harness.config.json`            | `init.sh`, CI, `package.json` scripts (`harness:*` → `harness …`), husky and lint-staged                                             |
| `templates/` — starting points for the project-owned files   | `docs/harness/` — evaluator rubric (with its tuning log), clean-state checklist, handoff, quality document, optional generator notes |
| `docs/` — how it works, configuration, adopting, developing  | `.claude/settings.json` — permissions (plugins cannot ship them) and the plugin pin                                                  |

## Documentation

- [docs/why.md](docs/why.md) — the failure modes each part counters and the principles to keep.
- [docs/how-it-works.md](docs/how-it-works.md) — the parts, one feature end to end, the safeguards, operating the loop, limits.
- [docs/config.md](docs/config.md) — every `harness.config.json` key.
- [docs/self-improvement.md](docs/self-improvement.md) — the retro: the loop finds problems in its own runs and builds the fixes.
- [docs/adopting.md](docs/adopting.md) — add the harness to a project, or move a project off a copied harness; acceptance checks.
- [docs/developing.md](docs/developing.md) — change the harness, test it against a project, release it.
- [CHANGELOG.md](CHANGELOG.md)

## Commands

The project's `package.json` maps `pnpm harness:<x>` to `harness <x>`, so docs, permissions and
evidence lines name `pnpm harness:*`.

| Command                                                                    | What it does                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `harness check [file]`                                                     | Validate `feature_list.json` (WIP=1, evidence before `passing`, dependencies, configured fields). |
| `harness feature next\|show\|list\|activate\|block\|unblock\|attempt`      | Feature state transitions; the only way a status changes.                                         |
| `harness verify F-NNN [--dry-run]`                                         | Run the feature's layers in order, record evidence, set `passing`.                                |
| `harness clean-state [--quick] [--allow-state-dirty] [--require-terminal]` | The clock-out gate.                                                                               |
| `harness loop [--once] [--feature F-NNN] [--dry-run]`                      | The unattended driver.                                                                            |
| `harness report`                                                           | Past driver runs.                                                                                 |
| `harness retro [--dry-run] [--signals] [--since <time>]`                   | Look back at the loop's runs and file harness problems as issues the loop builds.                 |
| `harness doctor`                                                           | Is the project wired correctly (config, plugin pin = package version, required files, leftovers). |
| `harness config`                                                           | Print the resolved configuration with defaults.                                                   |

## Requirements

Node ≥ 22.12, pnpm (the guard and the skills assume it), git ≥ 2.20, bash (Git Bash on Windows),
the `claude` CLI, and for the driver `gh`.

# Clean-state checklist

Run through this at clock-out, before committing. A session is not finished until every box is
ticked; `/harness:clock-out` walks the same list, and the loop driver refuses to open a PR until the
machine-checked part passes.

## Machine-checked — `pnpm harness:clean-state`

Exits 0 only when all of these hold. Flags: `--allow-state-dirty` (state files may be uncommitted),
`--quick` (skip `init.sh`, used by the Stop hook), `--require-terminal` (no feature may be left
`in_progress`; used for driver-run sessions), `--base <ref>` (diff base, default `origin/main`).

- [ ] Working tree is clean (or only `feature_list.json`, `PROGRESS.md`, `docs/harness/**` are dirty).
- [ ] `feature_list.json` is valid (WIP=1, evidence before `passing`, dependencies resolve).
- [ ] `PROGRESS.md` was updated on this branch.
- [ ] `.env` is neither tracked nor staged.
- [ ] The standard startup path still works: `FAST=1 ./init.sh` exits 0.
- [ ] (driver-run) The active feature ended `passing` or `blocked`, not `in_progress`.
- [ ] <one line per `cleanState.checks` / `cleanState.files` entry in harness.config.json, e.g. no
      `.only`/`.skip` added under `tests/`, no coverage threshold removed, no debug output added>

## Judgement — checked by the person or agent clocking out

- [ ] The standard verification path ran for the feature: `pnpm check`, plus L2/L3 when the feature lists them (`pnpm harness:verify` records the evidence).
- [ ] `PROGRESS.md` content is truthful: Current Verified State, session entry, concrete Next Steps.
- [ ] No half-finished step is left undocumented (notes on the feature, or a handoff in `docs/harness/session-handoff.md`).
- [ ] No debug artefacts: temporary files, commented-out code, stray logging.
- [ ] Secrets did not land in test env files or fixtures.
- [ ] Generated files were regenerated, not edited: <the project's generate commands>.
- [ ] Docs affected by the change were updated in the same commit (<the project's docs>).
- [ ] Commit subject follows conventional commits and the body explains why.
- [ ] The next session can continue without manual repair.

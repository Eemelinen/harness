---
name: clock-out
description: End a harness work session — run the clean-state check, update PROGRESS.md and feature_list.json, run pnpm check, optionally score the diff with the evaluator agent, and commit. Invoking this skill is the user's request to commit.
disable-model-invocation: true
allowed-tools: Read Bash(git status *) Bash(git diff *) Bash(git log *) Bash(git add *) Bash(git commit *) Bash(pnpm harness:*) Bash(pnpm check) Bash(FAST=1 ./init.sh) Bash(pnpm exec prettier *)
---

Run the clock-out routine from AGENTS.md → Clock-out and Definition of done.

1. `git status --short` and `git diff --stat`. Confirm the changes belong to the active feature only; list anything out of scope and ask before including it (in a driver-run session, `HARNESS_LOOP=1`, leave out-of-scope changes uncommitted and mention them in PROGRESS.md instead of asking).
2. Machine checks: `pnpm harness:clean-state --allow-state-dirty` (add `--require-terminal` when `HARNESS_LOOP=1`). Fix every `[FAIL]` it reports; never skip tests or weaken assertions to satisfy a check.
3. Judgement checks from `docs/harness/clean-state-checklist.md` → "Judgement": debug artefacts, generated files regenerated, docs updated in the same commit. Report each as done / not done.
4. `feature_list.json`: the active feature is `passing` only if `/harness:verify-feature` (i.e. `pnpm harness:verify`) recorded evidence; otherwise leave it `in_progress`, or `pnpm harness:feature block <id> --reason "…"`. Never set a status by hand.
5. Update `PROGRESS.md`:
   - Current Verified State: last verified commit (say "this commit" before committing), `pnpm check` result and date, highest-priority unfinished feature, current blocker.
   - Append a `### Session NNN — YYYY-MM-DD` entry (goal, completed, verification run, evidence, commits, files updated, known risk, next best step).
   - Rewrite Next Steps so a fresh session can start immediately.
   - For a long or multi-area session also add a handoff block at the top of `docs/harness/session-handoff.md`.
6. `pnpm check` (and the feature's L2/L3 if they were not run in this session). Stop and report if red.
7. When `HARNESS_LOOP=1`, skip this step: the loop driver runs the evaluator in its own session after yours, and the guard denies the agent. Otherwise, optional but recommended when a feature reaches `passing`: launch the `harness:evaluator` agent on the working tree. If the verdict is Revise or Block, address the findings before committing.
8. Commit: one logical change, conventional-commit subject, body that explains why; include the state files and any doc updates in the same commit. The guard hook re-runs `pnpm harness:check` on `git commit`. Do not push in a driver-run session; the driver pushes and opens the PR.
9. Confirm `pnpm harness:clean-state` exits 0 on the clean tree. Report the commit hash and the next best step.

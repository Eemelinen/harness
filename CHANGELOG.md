# Changelog

Releases are git tags (`vX.Y.Z`). Projects pin the package and the plugin marketplace to the same
tag; see [docs/developing.md](docs/developing.md).

## Unreleased

- **The loop fixes red CI on its own PRs.** Before, a failed required check on an auto-merge PR
  stopped the loop until a human fixed the branch.
  - The driver now passes the failed-job log excerpt to a fixer session in the feature's worktree
    (`prompts/ci-fixer.md`).
  - Fix commits go through the post-check and the evaluator, then are pushed.
  - Flaky and cancelled jobs are re-run once.
  - After `caps.maxCiFixAttempts` (default 2) the driver disables auto-merge, comments on the PR and
    moves on to independent features.
  - Fixer sessions show in `harness report` as `ci-fix` / `ci-rerun`.
- **The loop no longer waits forever on silent CI.** With auto-merge, a PR whose CI reports nothing
  for 20 minutes is given up the same way.
- **`harness check` and `harness doctor` fail when `init.sh` is not committed executable.** A
  Windows checkout commits it as `100644`, and `./init.sh` (skills, templates, the startup path)
  then fails on Linux and macOS with "Permission denied". The error names the fix
  (`git update-index --chmod=+x init.sh`).

## v0.1.0 — 2026-10-23

First release, extracted from the copies in Metsävahti, Personal Finances and Ideaforge.

- **One source of truth.** The harness ships as the `@eemelinen/harness` package (CLI `harness`:
  `check`, `feature`, `verify`, `clean-state`, `loop`, `report`, `doctor`, `config`) and the Claude
  Code plugin `harness` (skills `/harness:clock-in`, `/harness:verify-feature`, `/harness:clock-out`,
  agent `harness:evaluator`, guard / session-start / format / Stop hooks).
- **`harness.config.json` holds every project-specific value.** Projects now configure, instead of
  editing copied scripts:
  - ticket format and extra feature fields
  - guard Bash and path rules
  - clean-state checks
  - layer milestones
  - services, CI evidence notes
  - session-start status lines
  - formatter, generator notes, default branch, remote, branch prefix
- **Undeclared feature fields are rejected.** Before, the validator dropped them on the next write.
- **The clean-state check is TypeScript** (`harness clean-state`) instead of a bash script.
- **The hooks are dependency-free Node scripts** instead of bash with `node -e`. The Edit/Write
  guard now also covers MultiEdit.
- **Unattended sessions load the plugin from the installed package** (`--plugin-dir`), and the
  driver stops a session whose init event does not list the plugin.
- **`harness doctor`** checks that the plugin pin and the package version match.
- **Fixes merged from the copies:**
  - the loop stops waiting when CI fails on an auto-merge PR (Metsävahti)
  - guard rules can match only at command start, so heredocs and commit messages are not mistaken
    for commands (Ideaforge)

# Changelog

Releases are git tags (`vX.Y.Z`). Projects pin the package and the plugin marketplace to the same
tag; see [docs/developing.md](docs/developing.md). From v0.3.1 on, the release workflow writes each
entry from the commit subjects since the previous tag.

## v0.3.4 — 2026-10-24

- Start sessions without a GitHub token
- Drop Write deny rules that Claude Code ignores

## v0.3.3 — 2026-10-24

- Gate the retro intake on a triage label

## v0.3.2 — 2026-10-24

- Give quarantine issues a log excerpt and trace paths

## v0.3.1 — 2026-10-24

- Canary rollout of harness releases
- Probation, rollback and re-test after a harness update
- Stage harness rollouts and quarantine bad releases
- Selftest, schema-based breaking detection, versioned runs
- Hold release and update code for human review
- Update project loops to the newest harness release
- Release merges that change the package automatically

## v0.3.0 — 2026-10-24

- **The harness can improve itself.** `harness retro` collects the signals where the harness got in
  its own way (guard blocks, permission denials, driver errors, evaluator revisions, sessions near
  a cap). A read-only session separates harness defects from project setup problems, and each
  finding is filed as a `harness-retro` issue in the repository that owns the fix, deduplicated by
  fingerprint.
  - With `retro.intake`, a loop builds its repository's open retro issues as features; the PR
    closes the issue.
  - `retro.every` and `retro.onQueueEmpty` run retros from the loop.
  - All of it is off by default ([docs/self-improvement.md](docs/self-improvement.md)).
- **Loop PRs that change what sessions may do go through a merge gate.** A PR that touches a
  `reviewPaths` file (default `.claude/*`, `.github/workflows/*`, `harness.config.json`) is no
  longer auto-merged unchecked. Hard stops always wait for a human: reviewPaths shrinking, review
  settings or the permission mode changing, blanket allows, removed deny rules,
  `bypassPermissions`, the harness plugin disabled. Everything else goes to a read-only
  safety-review session, and a `safe` answer auto-merges with the review in the PR body. Set
  `review.mode: "human"` to make every such PR wait.
- **Loop sessions no longer run the evaluator themselves.** About 15 overnight generator sessions
  launched `harness:evaluator` before clock-out and idled until it answered, although the driver
  evaluates afterwards anyway. The guard now denies that agent call under `HARNESS_LOOP=1`, and the
  clock-out skill and generator prompt say so up front. Projects can drop the matching line from
  their generator notes.
- **Guard rules ignore heredoc data.** A Python edit or a `git commit -F - <<EOF` message that
  mentioned `pnpm db:up`, `git push` or `npm install` was blocked. Heredoc bodies are now dropped
  before matching unless the heredoc feeds a shell (`bash <<EOF`).
- **Resumed sessions report all their turns.** A session resumed by a wakeup or a background task
  recorded only its last segment's turns (87 + 18 + 2 turns showed as 2) in `runs.jsonl`, the PR
  body and `harness report`.
- **Merged leftover branches are no longer called in flight.** The queue-empty notice lists
  branches whose feature is already passing as leftovers that are safe to delete.

## v0.2.0 — 2026-10-23

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

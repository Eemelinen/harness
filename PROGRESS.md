# Progress log

Repository-local session log. Read it at clock-in, update it at clock-out (AGENTS.md). The
session-start hook prints the `## Current Verified State` section and the clean-state check requires
this file to change on every branch; keep that heading text exactly.

## Current Verified State

- Repository root: `harness/`.
- Standard startup path: `./init.sh` (`FAST=1` skips the baseline).
- Standard verification path: L1 `pnpm check` (typecheck, Prettier, `harness check`, Vitest). Per
  feature: `pnpm harness:verify F-NNN`.
- The repository runs its own loop: features come from `harness-retro` issues filed by project
  retros (docs/self-improvement.md). Merges that change a shipped path are released by
  `.github/workflows/release.yml` (docs/developing.md → Releasing); it needs the `RELEASE_TOKEN` secret.
- Last verified: F-016 on this branch, `pnpm check` green on 2026-10-24.
- Highest-priority unfinished feature: none (F-000…F-016 passing).
- Current blocker: none.

## Next Steps

1. Create the `RELEASE_TOKEN` secret and its bypass of the main protection (docs/developing.md →
   Releasing), then review and merge `feat/auto-release-update`. It changes the loop, the config and
   a workflow, so it waits for a human. The merge should release v0.3.1 on its own; check the
   Actions run.
2. Move the projects to that release once (`pnpm harness:update`, then `pnpm check` and a commit).
   Add Issues: read and write to `RELEASE_TOKEN`. Turn on `"update": { "auto": true }` in two
   projects with `merge: "auto"`, then run the drill on the next release. The first loop claims it on
   `rollout vX`, the other logs "being tested by …", and the release is verified after probation and
   taken by the other. A canary loop stopped mid-test lets its claim lapse after 4 h. A quarantine
   issue opened by hand makes the projects roll back.
3. Build open `harness-retro` issues as they arrive (`pnpm harness:loop`, intake picks them up).
4. After F-015 is released, Metsävahti can add `"exceptNewOnBranch": true` to its
   `src/payload/migrations/*` rule (and Personal Finances to its migrations rule), so a driver-run
   session can fix the `down` order of a migration it generated (harness#20).
5. After F-016 is released, watch the first loop PR that conflicts with the default branch: the log
   should show `merging origin/main into feat/F-NNN` instead of a 20-minute stall (harness#21).

## Session Log

### Session 006 — 2026-10-24 (F-016 attempt 2, driver-run)

- The evaluator's Revise on attempt 1: the shepherdPr conflict path, pinPr's conflict outcome and
  giveUp's merge abort had no test. Chose the evaluator's second option, pure decision functions,
  over driving shepherdPr itself (it needs the driver's module state, `claude` sessions, the
  evaluator and the merge gate). The conflict path in shepherdPr is now glue around
  `src/conflict.ts`: `conflictStep` (merge result → wait on the pushed head / fix with PROBLEM /
  give up), `nextFixAttempt` (a conflict uses the `caps.maxCiFixAttempts` budget), `fixerPrompt`
  (conflict-fixer.md vs ci-fixer.md), `fixNote` and `fixerGaveUp`. giveUp's worktree part is
  `handBack` (abort the merge, disable auto-merge, push) and pinPr's failure is `pinPrFailed`, both
  exported from `src/loop.ts` and tested with `gh` (and `claude`) stubbed on PATH.
- Give-up reasons after a conflict fixer session now start with "conflicts with <default branch>:
  fix N/M: …" (attempt 1 had "ci fix N/M: conflicts with …"); the review-hold and push-failure
  give-ups after a fixer session carry the same note prefix (for CI: "ci fix N/M: …"). With
  `caps.maxCiFixAttempts` 0 a conflict reads "no fixer session may resolve it".
- Tests (`tests/conflict.test.ts`): a clean merge yields `wait` on the pushed head; conflicts reach
  the conflict-fixer prompt with the files in PROBLEM; a clean merge failing L1 goes to the same
  fixer; the budget and every conflict give-up reason; `handBack` aborts the merge before
  `gh pr merge --disable-auto` (the stub records the worktree state) and pushes only when that
  succeeded; `pinPrFailed` disables auto-merge, reports "conflicts with main", runs no `claude`.
  A mutation check (handBack without the abort) fails the test. docs/how-it-works.md lists every
  give-up case of the conflict path.

### Session 005 — 2026-10-24 (F-016, driver-run)

- F-016 (retro issue #21): `waitForMerge()` reads `mergeable` and `headRefOid` in its `gh pr view`
  poll and, with auto-merge, returns `conflict` at once on `CONFLICTING` (UNKNOWN is ignored). A
  conflict counts only for the head the driver pushed, so a stale answer right after a push does not
  trigger a second merge. `shepherdPr()` calls `mergeDefaultBranch()` (new `src/conflict.ts`):
  fetch, fast-forward the driver checkout's default branch (so the merge gate and post-check diff
  against the current one), `git merge origin/<default>` in the worktree. Clean → L1, push, keep
  waiting. Conflicts → the merge stays in progress and a fixer session gets
  `prompts/conflict-fixer.md` (keep both sides, re-verify, commit the merge); it counts as a CI-fix
  attempt and goes through the same post-check, evaluator and merge gate. Give-up reasons read
  "conflicts with <default branch>: …", and `giveUp()` aborts an unfinished merge. `pinPr` disables
  auto-merge and reports "conflicts with <default branch>" without a fixer.
- Deviation from the spec: it names `config.project.check` as L1, but that key does not exist. The
  driver runs `bash <project.init>` instead, as `pinPr` already does for its L1 baseline: `init.sh`
  installs the merged dependencies (main may have changed the lockfile) and then runs L1. No config
  key was added.
- Two choices the spec left open: a clean merge whose L1 fails goes to the same fixer session (with
  the output tail) instead of giving up; and a clean merge is pushed without the evaluator, because
  main's side was reviewed already and the branch's own change is unchanged. Conflicts are acted on
  only with auto-merge, like red CI; a PR waiting for a human merge is left to the human.
- Tests (`tests/conflict.test.ts`): against a bare remote, a driver checkout, a feature worktree and a
  second clone — clean merge pushed and the default branch fast-forwarded, conflicting merge left in
  progress with its files and then aborted, clean merge with failing L1 kept unpushed, and the
  give-up paths (branch already contains main, fetch fails). `waitForMerge` with `gh` stubbed on
  PATH: CONFLICTING → conflict at once, UNKNOWN keeps waiting, a conflict for an older head is
  ignored, no conflict without auto-merge. `shepherdPr` itself still has no unit test (it needs
  the driver's module state and sessions). Verification: `pnpm harness:verify F-016`.
- This changes the loop and a prompt, so the PR waits for a human (reviewPaths).

### Session 004 — 2026-10-24 (F-015, driver-run)

- F-015 (retro issue #20): a `guard.paths` rule with `"exceptNewOnBranch": true` does not fire
  for a file missing at the merge base of HEAD and the default branch (`<remote>/<defaultBranch>`
  first, then `<defaultBranch>`); evaluation moves on to the next rule. Implemented as proposed,
  with one placement choice: `evaluate` in `guard-rules.mjs` stays pure and takes an
  `existsOnBase(rel)` callback, and the git calls (`git merge-base`, `git cat-file -e
  <base>:./<rel>`) live in `existsOnBaseIn` in `plugin/hooks/lib.mjs`, which `guard.mjs` passes
  in. The callback returns null when git can't answer, and the rule then fires as before. The
  `./` form resolves the path from the project root even when it is below the repository top.
  Renames count as new files under their new name (documented in docs/config.md). Tests: the rule
  order with a stub callback, and the hook process against a temporary repository (committed and
  untracked new files pass, a file on the default branch asks, `origin/<branch>` wins over the
  local branch, no repository or no merge base asks). Verification: `pnpm harness:verify F-015`.
- This changes the guard and the config, so the PR waits for a human (reviewPaths).

### Session 003 — 2026-10-24 (automatic releases, project updates, rollout safety)

- Goal: release every merge that changes the package (F-004), and let project loops move to the
  newest release before each feature (F-005). Then make that rollout safe enough to run unattended
  across projects (F-006…F-008). All were requested by hand.
- F-004: `scripts/release.ts` (not `src/`: repository tooling, not shipped) bumps the patch number,
  or the minor number for a `!`/`BREAKING CHANGE` commit while 0.x; it releases nothing when no
  `package.json` `files` path changed. `release.yml` runs it after CI passes on a push to main and
  pushes with `RELEASE_TOKEN`, because main is protected. Verification: `pnpm harness:verify F-004`.
- F-005: `update.auto` (off by default). Before each feature the driver compares the newest `v*`
  tag (`git ls-remote`) with the installed package. It opens a `harness/update-vX.Y.Z` PR from its
  own worktree (pins only, new doctor plus `init.sh` with L1), auto-merges it under the auto policy,
  pulls, reinstalls and re-execs itself with `HARNESS_LOOP_CARRY` (attempted features, retro and
  failure counts). `harness update [--to] [--check]` does the same by hand. Breaking releases are
  only reported unless `update.allowBreaking`. The plan had the update inside feature PRs as an
  alternative; it was rejected because `.claude/settings.json` is in reviewPaths, so every feature
  PR would wait for a human. Verification: `pnpm harness:verify F-005`; `harness update --check`
  run against personal-finances (read-only) found v0.3.0 as newest.
- F-006 (rollout safety, part 1 of 3): `harness selftest` runs the installed harness against a
  project. The guard must block its core cases and allow the project's `allowedTools` and
  verification commands, the hooks must exit cleanly, and doctor must pass. It's part of `pnpm check`
  here. All three projects passed it read-only. The release script now reads breaking changes from
  the config schema diff, because loop PR titles never carry `!`. Run records carry the harness
  version. Verification: `pnpm harness:verify F-006`.
- F-007 (part 2 of 3): `pickTarget` took the newest release that was old enough
  (`update.minAgeHours`, replaced by F-009), not breaking and not quarantined. Releases and
  `harness-quarantine` issues are read with `gh`; `git ls-remote` is only a fallback for
  `harness update` without `gh`. A project on a quarantined release moves forward to the fix or back
  (`harness/rollback-vX`). The update PR runs the old and the new selftest, and a regression
  quarantines the release through `src/quarantine.ts`. That issue carries a feature block for this
  repo's intake, with one fingerprint per version. Verification: `pnpm harness:verify F-007`.
- F-008 (part 3 of 3): the first feature after an update runs on probation. If it isn't `done`, the
  run is set aside as `harness/probation-vX-F-NNN` (its attempts don't count), the pins roll back
  through `pinPr`, and the driver restarts and re-runs the feature (`carry.retry`). Passing on the
  old version quarantines the release; failing again clears it. The parent driver supervises the
  restarted one. A non-zero exit with no settled probation means a rollback, then the old preflight
  as an A/B check, then quarantine. Verification: `pnpm harness:verify F-008`.
- F-009: the fixed waiting time (`update.minAgeHours`, never released) is replaced by a canary
  rollout. The release workflow opens `rollout vX.Y.Z`. The first loop with `update.canary` claims
  it in a comment (earliest live claim wins), renews the claim every 30 min while on probation, and
  marks the release verified when the probation passes. Others take only verified releases. A claim
  lapses after `update.canaryHours` (4; the "quarantine time" in the request). A failed update or an
  inconclusive re-test releases it; a quarantine closes the issue. `RELEASE_TOKEN` now also needs
  Issues: read and write. Verification: `pnpm harness:verify F-009`.
- F-010: quarantine issues carry an excerpt of the failing run's readable log (telling lines plus
  the end, at most 1400 characters, so it survives the intake's 3000-character notes) and the
  absolute paths of that log and its traces. Verification: `pnpm harness:verify F-010`.
- F-011: `retro.intakeLabel` gates the intake on a label (default unset). The package exports the
  issue, quarantine and rollout readers for harness-updater, the Docker service that triages
  harness issues. The harness config is switched to `intakeLabel: "updater:accepted"` only once
  the updater runs in triage mode. Verification: `pnpm harness:verify F-011`.
- F-012: driver-started sessions run with `sessionEnv`: no GitHub token variables and an empty
  `GH_CONFIG_DIR`, so `gh` is logged out in a session even on a machine where `gh auth login` is
  stored. The driver keeps its own access. Prompted by harness-updater, which runs the loop with
  the owner's token. Also: the settings template no longer carries `Write(...)` deny rules, which
  Claude Code ignores (`Edit(...)` covers every file-editing tool). Verification:
  `pnpm harness:verify F-012`.
- F-013 (found live in metsavahti): after `pnpm install` repointed `node_modules/@eemelinen/harness`,
  `require.resolve` in the running driver still returned the old package (Node caches real paths).
  So the "restarted" driver was the old code. It failed the doctor on the new pins (exit 1), and the
  supervisor rolled back and quarantined v0.3.2 (#11, a false alarm); v0.3.3 failed the same way.
  `installedRoot` now resolves from the file system with `realpathSync.native`. `restart` refuses a
  version mismatch, and a restarted driver that isn't the probation version records
  `restart-mismatch`, which the supervisor treats as settled. The bug is in the parent, so every
  project on v0.3.1–v0.3.4 needs one hand update to the release with this fix. Verification:
  `pnpm harness:verify F-013`; a test reproduces the cached `require.resolve`.
- The intake is gated on `updater:accepted` (`retro.intakeLabel` in this repo's config):
  harness-updater (Docker, triage mode) validates each retro and quarantine issue first, and this
  loop builds only the ones it accepted. A config-only change: nothing is released.
- F-014 (proposed by harness-updater's triage of #11): the restarted driver's output is teed to
  `.harness/traces/driver-vX-<time>.log` (`spawnTee`). A crash before the first feature settles puts
  its error line (`crashMessage`) into the rollback reason and the quarantine cause, with an excerpt
  and the log path. Verification: `pnpm harness:verify F-014`.
- Bootstrapping: rollback and re-test run in the version a project rolls back to, so they are
  complete only from the release after the one that ships F-008. Until then the staged rollout and
  the selftest (F-007) are the guard.
- `src/update.ts` and `scripts/release.ts` were added to this repository's reviewPaths: one decides
  which update PRs skip a project's merge gate, the other runs with a token that can push to main.
- Known risk: neither the release workflow nor a real update, rollback or quarantine has run yet;
  only their decision logic is unit-tested. They need
  the `RELEASE_TOKEN` secret, a merge, and a project loop with `update.auto` on. The changelog is
  now a list of commit subjects instead of curated prose.

### Session 002 — 2026-10-24 (fixes from the first overnight loops)

- Goal: fix what the overnight loops of idea-generator, personal-finances and metsavahti showed
  (F-001…F-003, added by hand from the run logs; no retro issue was filed).
- F-001: generators ran `harness:evaluator` themselves before clock-out (about 15 of ~60 sessions)
  and idled on `ScheduleWakeup` for it. Clock-out step 7 only said "skip when `HARNESS_LOOP=1`" in a
  trailing parenthesis, and the generator prompt tells sessions to follow those steps. The guard now
  denies an `Agent`/`Task` call for the evaluator in loop mode (new `Agent|Task` PreToolUse matcher),
  step 7 leads with the condition and the generator prompt says to skip it. Interactive sessions can
  still run the evaluator. The projects pin v0.2.0, so each got the same rule in its
  `docs/harness/generator-notes.md` until a release reaches them.
- Verification: `pnpm harness:verify F-001` → L1 `pnpm check` pass.
- F-002: a session resumed by a wakeup ends each segment with its own `result`; the driver kept
  only the last, so runs.jsonl showed 1–4 turns for $3–10 sessions (personal-finances F-015: 87 + 18
  - 2 recorded as 2). `mergeResult` sums `num_turns`; `total_cost_usd`, `modelUsage` and
    `duration_api_ms` are already session totals in every segment (checked against three traces), so
    the cost was right. Verification: `pnpm harness:verify F-002` → L1 pass.
- F-003: the queue-empty notice called `feat/F-006` (idea-generator) and `feat/F-002`
  (personal-finances) in flight, though both had merged; their remote branches survived the first
  merge in each repo. `queueEmptyNotice` names branches of `passing` features separately as safe to
  delete. Verification: `pnpm harness:verify F-003` → L1 pass.
- Known risk: none of this reaches the projects before a release; the `Agent|Task` matcher is new,
  so watch the first loop after the release for unexpected denials.

### Session 001 — 2026-10-23 (self-hosting bootstrap)

- Goal: make this repository a harness project so its loop can build retro fixes.
- Completed: `harness.config.json`, `feature_list.json`, AGENTS.md, init.sh, `docs/harness/`;
  `harness:*` scripts; the doctor accepts the harness repository without a plugin pin; loop sessions
  here get the plugin of the driver's checkout, never the one they edit.
- Verification: `pnpm harness:verify F-000` → L1 `pnpm check` and `pnpm harness:doctor` pass; F-000 passing.
- Next best step: once released, enable `retro` in the projects and run this loop for the issues they file.

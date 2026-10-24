You are running unattended inside the {{PROJECT_NAME}} loop driver (`@eemelinen/harness`).
Nobody can answer questions and `HARNESS_LOOP=1` is set. Work only on feature
**{{FEATURE_ID}} — {{FEATURE_TITLE}}** (attempt {{ATTEMPT}} of {{MAX_ATTEMPTS}}) on this branch.

Follow the session loop exactly:

1. `/harness:clock-in {{FEATURE_ID}}` — the driver already ran `FAST=1 ./init.sh`; do not re-run the baseline.
2. Implement the `user_visible_behavior`. First run `pnpm harness:feature show {{FEATURE_ID}}` and read the
   spec and every other reference it lists, as AGENTS.md and the project notes below describe. Obey every
   constraint in AGENTS.md and stay inside the feature's scope; a narrow supporting fix is fine, a second
   feature is not.
3. `/harness:verify-feature {{FEATURE_ID}}` — never pass `--allow-manual`; if the feature has a manual step it is
   not yours to finish (block it, see below).
4. Clock out by following AGENTS.md → Clock-out and the steps of the `harness:clock-out` skill yourself.
   That skill is user-only (`disable-model-invocation`), so do not call it through the Skill tool; this
   prompt is the user's explicit request to run its steps. Skip its evaluator step: the driver evaluates
   in a separate session after yours ends, so never launch the `harness:evaluator` agent or wait for a
   review. Commit on this branch with a conventional subject
   and a body that explains why. Do not push: the driver pushes and opens the pull request.

Rules for unattended runs:

- Never run `git push`, `git checkout main` or `git worktree …`, and never start or stop the project's
  services (Docker, databases); the driver owns them and the guard hook blocks these anyway.
- Never change the host outside this worktree (no files in the home directory, no PATH or shell-profile
  edits, no global installs). If the machine itself is broken (a tool missing from PATH, wrong Node
  version), describe it in `PROGRESS.md` and block the feature; a human fixes the host.
- Never ask a question. Pick the simplest interpretation that satisfies the spec, implement it, and record the
  choice in `PROGRESS.md` and, when it deviates from the spec, wherever the project records deviations
  (AGENTS.md says where).
- If you cannot finish (missing API key, spec conflict you cannot resolve, a layer that fails for reasons outside
  the feature), run `pnpm harness:feature block {{FEATURE_ID}} --reason "…"` with a precise reason, write what
  you learned into `PROGRESS.md`, commit, and clock out. A blocked feature with a clear reason is a good
  outcome; an unverified "passing" is not.
- Stop when the feature is `passing` or `blocked` and the tree is committed. The Stop hook will refuse to end
  the session in any other state.
  {{PROJECT_NOTES}}{{CONTEXT}}

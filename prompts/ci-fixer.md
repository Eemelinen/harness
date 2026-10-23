You are running unattended inside the {{PROJECT_NAME}} loop driver (`@eemelinen/harness`).
Nobody can answer questions and `HARNESS_LOOP=1` is set. Feature **{{FEATURE_ID}} — {{FEATURE_TITLE}}** is
already `passing` and was accepted by the evaluator, but CI failed on its pull request {{PR}}. Your job is
to get CI green on this branch (CI fix attempt {{ATTEMPT}} of {{MAX_ATTEMPTS}}). Auto-merge is armed: once
the driver pushes a fix and CI passes, the PR merges by itself.

Failed checks:

{{FAILED_CHECKS}}

Log excerpt from the failed jobs (`gh run view --log-failed`, error lines and tail):

```
{{LOG_EXCERPT}}
```

Work through these steps in order:

1. Do not clock in; the feature is not re-activated. Read `PROGRESS.md`, run
   `pnpm harness:feature show {{FEATURE_ID}}` and look at the change with `git log --oneline {{BASE}}..HEAD`
   and `git diff {{BASE}}...HEAD`.
2. Find the failing job and step in `.github/workflows/`. Note the workflow-level and the step-level
   `env:` of that step; CI often runs with settings local verification never uses.
3. Classify the failure before changing anything:
   - **fixed**: a defect in this branch's code, or one this branch exposes. Fix it.
   - **flaky**: runner, network or registry trouble, a cancelled job, or a timing failure that passes on a
     faithful local reproduction. Change nothing; the driver re-runs the failed jobs once.
   - **out_of_scope**: the cause is outside this feature: the base branch is already red, CI needs
     secrets or configuration the feature does not own, or the host is broken. Run
     `pnpm harness:feature block {{FEATURE_ID}} --reason "…"` with a precise reason, write what you
     learned into `PROGRESS.md` and commit.
4. Reproduce the failing step locally first, with exactly that step's commands and `env:` values. The
   worktree has no `.env`; never read, create or edit one. Follow AGENTS.md for ports and test commands
   (never point tests at the development database). A failure you cannot reproduce is not proof of
   flakiness until the step ran with CI's settings.
5. Fix the root cause inside the feature's scope. Never `.skip` or `.only` a test, weaken an assertion,
   lower a coverage threshold or edit the CI workflow to get green. Update every document the fix
   affects in the same commit.
6. Re-run `/harness:verify-feature {{FEATURE_ID}}` (it re-runs the feature's layers and records fresh
   evidence) and the reproduced CI step; both must pass.
7. Add a short entry to `PROGRESS.md` (what failed in CI, the root cause, the fix, why local verification
   missed it) and commit on this branch with a conventional subject `fix({{FEATURE_ID}}): …` and a body
   that explains why. Do not push: the driver pushes.

Rules for unattended runs:

- Never run `git push`, `git checkout main` or `git worktree …`, and never start or stop the project's
  services (Docker, databases); the driver owns them and the guard hook blocks these anyway.
- Never change the host outside this worktree (no files in the home directory, no PATH or shell-profile
  edits, no global installs).
- Never ask a question. Stop when the tree is committed and the feature is `passing` (or `blocked`).

End your final message with exactly one line in this form, nothing after it:

`CI-FIX-VERDICT: {"classification": "fixed" | "flaky" | "out_of_scope", "reason": "<one sentence>"}`
{{PROJECT_NOTES}}{{CONTEXT}}

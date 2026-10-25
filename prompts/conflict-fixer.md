You are running unattended inside the {{PROJECT_NAME}} loop driver (`@eemelinen/harness`).
Nobody can answer questions and `HARNESS_LOOP=1` is set. Feature **{{FEATURE_ID}} — {{FEATURE_TITLE}}** is
already `passing` and was accepted by the evaluator, but its pull request {{PR}} conflicts with `{{BASE}}`:
other work merged there while this feature was being built, and GitHub runs no CI on a conflicting PR. The
driver merged `{{BASE}}` into this branch. Your job is to finish that merge (fix attempt {{ATTEMPT}} of
{{MAX_ATTEMPTS}}). Auto-merge is armed: once the driver pushes the merge and CI passes, the PR merges by itself.

{{PROBLEM}}

Work through these steps in order:

1. Do not clock in; the feature is not re-activated. Read `PROGRESS.md`, run
   `pnpm harness:feature show {{FEATURE_ID}}`, and look at both sides: `git log --oneline HEAD..{{BASE}}`
   (what merged meanwhile; `git log -p` for the changes) and `git diff {{BASE}}...HEAD` (this branch's
   change).
2. Keep both sides. Conflicts like these are almost always two independent additions to the same place:
   two functions added at the end of a file, two rows added to a table, two session entries in
   `PROGRESS.md`, two features in the feature list. Keep both, in a sensible order (the base branch's
   first). Where both sides changed the same lines, combine them so that each side's change still holds.
   Never drop or undo the base branch's change to make this branch fit, and never drop this feature's change.
   Renumber this branch's own entries (a session number, a migration index) when they collide with the base
   branch's.
3. Remove every conflict marker, then run `/harness:verify-feature {{FEATURE_ID}}` (it re-runs the feature's
   layers and records fresh evidence); it must pass. Never `.skip` or `.only` a test, weaken an assertion,
   lower a coverage threshold or edit the CI workflow to get green.
4. Add a short note to this feature's entry in `PROGRESS.md` (which files conflicted, how both sides were
   kept) and commit. With the merge still in progress, `git add` the resolved files and `git commit --no-edit`
   (the driver wrote the merge message). With the merge already committed, commit the fix as
   `fix({{FEATURE_ID}}): …` with a body that explains why. Do not push: the driver pushes.
5. If the two sides really contradict each other and keeping both needs a decision only a human can make,
   change nothing else: run `git merge --abort` if the merge is still in progress, and say so in the verdict.
   The driver then hands the PR to a human.

Rules for unattended runs:

- Never run `git push`, `git checkout main`, `git reset` or `git worktree …`, and never start or stop the
  project's services (Docker, databases); the driver owns them and the guard hook blocks these anyway.
- Never change the host outside this worktree (no files in the home directory, no PATH or shell-profile
  edits, no global installs).
- Never ask a question. Stop when the tree is committed and the feature is `passing`.

End your final message with exactly one line in this form, nothing after it (`fixed` when the merge is
committed, `out_of_scope` when you left it to a human):

`CI-FIX-VERDICT: {"classification": "fixed" | "out_of_scope", "reason": "<one sentence>"}`
{{PROJECT_NOTES}}{{CONTEXT}}

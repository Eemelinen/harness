# Evaluator rubric

Use after a feature is implemented and before it is accepted. In Claude Code the
`harness:evaluator` agent (from the harness plugin) applies this rubric to the working-tree
diff with a fresh context; humans can use it the same way in review.

Score each category 0–2. **Every category must score 2 for Accept**; any 1 → Revise;
any 0 → Block.

| Category          | Question                                                                     | 2 = pass when                                                                               | Score | Notes |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----- | ----- |
| Correctness       | Does the implemented behaviour match `user_visible_behavior` of the feature? | Every clause of the behaviour is exercised by a test or a documented manual step.           |       |       |
| Verification      | Did the required checks actually run, with evidence?                         | Each `verification` entry has a matching evidence line with date, command and commit hash.  |       |       |
| Scope discipline  | Did the session stay inside the chosen feature?                              | `git diff --stat` touches only files the feature needs (plus docs/state files).             |       |       |
| Reliability       | Does the result survive restart or rerun without repair?                     | `FAST=1 ./init.sh` and the relevant `pnpm test:*` pass twice in a row; no order dependence. |       |       |
| Maintainability   | Is the code and documentation clear enough for the next session?             | Boundaries in the architecture doc respected; new decisions recorded; no dead code.         |       |       |
| Handoff readiness | Can a fresh session continue from repo artefacts only?                       | `PROGRESS.md` Next Steps are concrete; `feature_list.json` status is truthful.              |       |       |

## Verdict

- Accept — all categories 2.
- Revise — at least one category 1; list the required fixes.
- Block — at least one category 0; do not commit as `passing`.

## Required follow-up

- Missing evidence:
- Required fixes:
- Next review trigger:

## Machine output (loop driver)

The driver (`pnpm harness:loop`) runs the evaluator as a separate `claude -p` session with the
instructions and tools of the plugin's `agents/evaluator.md` (`--append-system-prompt`, `--tools`;
`--agent` would ignore the schema) and `--json-schema` with the package's
`prompts/evaluator-schema.json`, and acts on the result without a human: Accept → push + PR, Revise → one bounded retry with the findings appended to
the generator prompt, Block → the feature is set `blocked` and the branch is pushed for a human.
The scores use the keys `correctness`, `verification`, `scope`, `reliability`, `maintainability`,
`handoff`. A missing or unparsable verdict counts as Revise.

## Tuning log

Out of the box an agent is a poor self-judge: it finds issues, then talks itself into
approving. Compare the evaluator's scores with your own on real sessions and tighten the
"2 = pass when" column where they diverge. Plan for 3–5 rounds; record each change here.

| Date       | Change to the rubric                        | Why |
| ---------- | ------------------------------------------- | --- |
| YYYY-MM-DD | Initial version (from the harness template) | —   |

Evaluate feature {{FEATURE_ID}} — {{FEATURE_TITLE}} on this branch with a fresh mind. The change is
`git diff {{BASE}}...HEAD` (commits: `git log --oneline {{BASE}}..HEAD`). Apply
`docs/harness/evaluator-rubric.md` strictly and return the structured verdict; the loop driver acts on
it without a human in between, so a lenient Accept ships unverified work and a lazy Block wastes a retry.
Cite files, lines and command output for every score. Do not edit anything.
{{CONTEXT}}

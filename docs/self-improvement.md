# Self-improvement: the retro

The loop records everything a session does, including where the harness got in the way: a guard
rule that blocked a legitimate command, an evaluator that could not run a read-only check, a
driver log line that reported a failure that did not happen. The retro reads those records,
decides which problems belong to the harness rather than to the feature, and files each one so the
loop builds the fix like any other feature. The more the harness is used, the more it fixes itself.

```
loop runs features ──► traces, driver logs, runs.jsonl
        ▲                       │
        │                harness retro: collect signals → read-only analysis session
        │                       │
        │          issue labelled harness-retro in the repository that owns the fix
        │             (the harness repository, or this project for its own setup)
        │                       │
        └── retro.intake: the owning repository's loop turns the issue into a feature,
            builds it on its branch, evaluator, PR "Closes #N", merge gate, auto-merge
```

## What happens in a retro

1. **Collect** (no model, no cost). From the traces, logs and run records since the last retro:
   - `guard-block`: a PreToolUse hook blocked a call (the reason, the command, and which agent made it)
   - `permission-denial`: the classifier or the permission list denied a call
   - `driver-error`: a line the driver itself logged as failed, an error or a warning, and test
     milestones that name a hook (a blocked command reported as a failed test)
   - `evaluator-revise`: a Revise or Block verdict
   - `attempt-failed`, `feature-blocked`, `ci-fix`: from `runs.jsonl`
   - `near-cap`: a session used over 80% of its turns, budget or wall clock

   Signals that differ only in quoted text, numbers or paths are grouped, with a count, the
   features they hit and up to three examples. `harness retro --signals` prints them.

2. **Analyse.** One read-only session (`prompts/retro.md`; Read, Glob and Grep only) reads the
   traces behind the signals, the project's harness setup and the harness source. It sorts each
   signal into a **harness** defect, a **project** setup problem, or the feature's own business,
   which is most of them and is dropped. It returns at most five findings with evidence, a fix, the
   checks that prove it, a `safety` flag and a confidence.
3. **File.** Each high or medium finding becomes an issue labelled `harness-retro` in the owning
   repository: the harness repository (`retro.harnessRepo`, default the package's `repository`)
   or this project's. Low-confidence findings stay in the report. The issue ends with a
   `harness-feature` JSON block (what the loop will build) and a fingerprint. A finding whose
   fingerprint matches an open issue adds its evidence as a comment instead of a new issue; one
   that matches an issue closed as not planned is dropped.

The report goes to `.harness/retro/<time>.md`; the run log gets a `retro` row with the cost.

## Intake: issues become features

With `retro.intake`, each loop iteration first looks for the oldest open `harness-retro` issue of
its own repository that is not labelled `harness-retro:queued`. It:

- gives it the next free `F-NNN` (above the feature list and every open `feat/F-*` branch)
- labels the issue `harness-retro:queued` and comments the branch
- adds the feature to `feature_list.json` **on the feature branch**. The default branch is
  protected and the driver never pushes it; the PR that builds the fix also adds the feature.
- runs it like any feature: generator, post-check, evaluator, PR with `Closes #N`

Retro issues run before the feature list's own ready features. To change what the loop builds,
edit the `harness-feature` block in the issue before it is queued. To reject a finding, close the
issue as not planned: the retro will not file it again.

## Safety: the merge gate

A self-improving loop must not be able to widen its own limits. Every loop PR passes a merge gate
before auto-merge is armed (`src/review.ts`). It needs review when:

- it changes a file under `reviewPaths` (default: `.claude/*`, `.github/workflows/*`,
  `harness.config.json`; add project hooks that live elsewhere). This applies to every loop PR, not
  only retro ones.
- it comes from a retro issue marked as a safety change: the fix touches the guard, permissions,
  allowedTools, hooks, `reviewPaths`, the evaluator's tools, or the retro and intake themselves.

What happens then depends on `review.mode`:

- **`evaluate`** (the default; for projects): first the **hard stops**, checked in code, not by a
  model. These never auto-merge: `reviewPaths` shrinking, `review` changing,
  `generator.permissionMode` changing, an `allowedTools` or `permissions.allow` entry that allows
  every command, deny rules removed, `defaultMode: bypassPermissions`, the harness plugin disabled,
  `harness.config.json` no longer parsing. Otherwise a read-only **safety review** session
  (`prompts/safety-review.md`) reads the changes and answers one question: can unattended sessions
  now do something harmful they could not do before (destructive or outward-facing commands,
  weaker verification, exposed secrets)? `safe` → auto-merge, with the review in the PR body.
  `unsafe` or no verdict → the PR waits for a human.
- **`human`** (the harness repository): the PR always waits for a human.

The gate uses the driver's own config, not the branch's, so a PR cannot loosen its own gate. A CI
fix on an auto-merge PR passes the same gate before it is pushed; if it now needs a human, the
driver disables auto-merge and hands the PR over. A held PR's body says why, the driver notifies
you, and the loop continues with features that do not depend on it.

A merged harness fix is released automatically. It reaches a project when the project's pins move
([developing.md](developing.md) → Releasing): by hand, or before the next feature when the project
sets `update.auto`. With `update.auto`, a fix the loop got wrong can reach other projects' running
loops. These layers keep it contained:

- **In the harness repository:** its merge gate (`reviewPaths` with `review.mode: "human"` hold the
  guard, hooks, prompts, loop, update and release code for a human), and CI with
  `harness selftest`.
- **When it ships:** breaking changes, including config schema breaks, are released as breaking,
  and projects don't take those on their own.
- **Staged rollout:** a waiting time (`update.minAgeHours`) after one canary project takes the
  release first.
- **Per project:** the update PR's selftest against the installed version, its doctor and L1
  baseline, and the project's CI.
- **Quarantine:** a release found bad is held back from every project, and projects already on it
  move off it ([how-it-works.md](how-it-works.md#4-operating-the-loop)).

Leave `update.auto` off where that is still too much trust.

## Turning it on

```jsonc
// harness.config.json
"retro": {
  "every": 5,           // a retro after every 5 features in one loop run (0 = never)
  "onQueueEmpty": true, // and when the queue runs dry, if features ran since the last one
  "intake": true        // build this repository's retro issues as features
}
```

`harness retro` runs one by hand; `--dry-run` analyses without filing, `--signals` only collects,
`--since <ISO time>` overrides the window (default: since the last retro). Keys and defaults:
[config.md → Driver keys](config.md#driver-keys).

**Cost.** Collecting is free. The analysis session is capped at `retro.maxBudgetUsd` (default 3
USD) and usually costs about one dollar; a retro with no signals runs no session. At most
`retro.maxPerLoop` (default 3) retros run per loop run, so retro fixes cannot keep the loop busy
with retros.

## Limits

- The analysis is a model's judgement. A wrong finding costs one loop run and a PR you can close;
  `confidence` and the dedupe keep the noise down, and a not-planned close is remembered.
- A harness finding is seen from one project's traces. The fingerprint merges reports of the same
  problem from several projects into one issue.
- Fixes in the harness repository are built by that repository's own loop (it is a harness project
  too). Until the project's pins move to the release, projects keep reporting the problem they still have; those
  reports land as comments on the closed issue.

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
  retros (docs/self-improvement.md). Releases stay manual (docs/developing.md → Releasing).
- Last verified: F-003 on this commit, `pnpm check` green on 2026-10-24.
- Highest-priority unfinished feature: none (F-001…F-003 passing).
- Current blocker: none.

## Next Steps

1. Review and merge this branch (stacked on `feat/retro`, PR #3); it changes the guard, hooks and
   prompts, so it waits for a human.
2. Cut a release so the projects pick up F-001…F-003; until then their `generator-notes.md` carry
   the no-self-evaluation rule.
3. Build open `harness-retro` issues as they arrive (`pnpm harness:loop`, intake picks them up).

## Session Log

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

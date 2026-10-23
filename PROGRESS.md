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
- Current blocker: none.

## Next Steps

1. Build open `harness-retro` issues as they arrive (`pnpm harness:loop`, intake picks them up).

## Session Log

### Session 001 — 2026-10-23 (self-hosting bootstrap)

- Goal: make this repository a harness project so its loop can build retro fixes.
- Completed: `harness.config.json`, `feature_list.json`, AGENTS.md, init.sh, `docs/harness/`;
  `harness:*` scripts; the doctor accepts the harness repository without a plugin pin; loop sessions
  here get the plugin of the driver's checkout, never the one they edit.
- Verification: `pnpm harness:verify F-000` → L1 `pnpm check` and `pnpm harness:doctor` pass; F-000 passing.
- Next best step: once released, enable `retro` in the projects and run this loop for the issues they file.

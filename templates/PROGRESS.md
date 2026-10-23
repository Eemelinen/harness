# Progress log

Repository-local session log. Read it at clock-in, update it at clock-out (AGENTS.md). The
session-start hook prints the `## Current Verified State` section and the clean-state check requires
this file to change on every branch; keep that heading text exactly.

## Current Verified State

- Repository root: `<repo>/`.
- Standard startup path: `./init.sh` (`FAST=1` skips the baseline).
- Standard verification path: L1 `pnpm check` · L2 … · L3 … Per feature: `pnpm harness:verify F-NNN`.
- Last verified commit: <hash> — `pnpm check` green on <date>.
- Current blocker: none.

## Next Steps

1. …

## Session Log

### Session 001 — YYYY-MM-DD (harness bootstrap)

- Goal / Completed / Verification / Evidence / Commits / Known risk / Next best step

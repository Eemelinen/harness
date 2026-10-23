---
name: clock-in
description: Start a harness work session — read PROGRESS.md and feature_list.json, run ./init.sh, report the baseline and activate exactly one feature (WIP=1). Use when the user says "clock in", "start a session", "what should I work on next", or before beginning feature work in a repository with harness.config.json.
argument-hint: '[feature-id]'
allowed-tools: Read Bash(pwd) Bash(git log *) Bash(git status *) Bash(./init.sh) Bash(FAST=1 ./init.sh) Bash(pnpm harness:*) Bash(pnpm check)
---

Run the clock-in routine from AGENTS.md → Clock-in. Requested feature: `$ARGUMENTS` (empty = pick automatically).

1. `pwd` — confirm the repository root (it contains `AGENTS.md`, `PROGRESS.md`, `feature_list.json`, `harness.config.json`).
2. Read `PROGRESS.md`: Current Verified State and Next Steps. Read `feature_list.json` (or `pnpm harness:feature list`).
3. `git log --oneline -5` and `git status --short`. If source files (the directories in `harness.config.json` → `project.sourceDirs`, `src/` by default) are dirty while the state files are not, stop and report: a previous session ended without clock-out; do not build on top of it without the user's decision.
4. `./init.sh` (use `FAST=1 ./init.sh` only if the user asked for a quick start, or when `HARNESS_LOOP=1` is set — the driver already ran it). If it fails, the baseline is red: fixing that is the session's first job. Report the failure and stop the routine.
5. Choose the feature: the requested id if given, otherwise `pnpm harness:feature next --include-manual` (lowest priority, `not_started`, every `depends_on` passing). If a feature is already `in_progress`, continue it instead — never activate a second one.
6. `pnpm harness:feature show <id>`: quote its `user_visible_behavior` and `verification`, and its `ticket`, `spec` and any project-specific fields (such as `design`). Read the linked spec and every other reference the feature lists, as AGENTS.md describes, before writing code. Confirm with the user that this is the feature to work on (skip the confirmation when `HARNESS_LOOP=1`).
7. `pnpm harness:feature activate <id>` — it enforces WIP=1 and the dependency rule, bumps `last_updated` and re-validates the file. Never edit the status by hand.

Finish with a short summary: baseline result, active feature, the layers it needs, and any blocker from `PROGRESS.md`.

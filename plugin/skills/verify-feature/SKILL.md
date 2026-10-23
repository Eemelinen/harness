---
name: verify-feature
description: Run a feature's verification layers from feature_list.json in order (L1 → L2 → L3 → manual), stop at the first failure, and on success record evidence and set the feature to passing. Use when a feature's implementation is believed complete or the user asks to verify a feature.
argument-hint: '<feature-id>'
allowed-tools: Read Bash(pnpm harness:*) Bash(docker info*) Bash(git status *) Bash(git log *)
---

Verify feature `$ARGUMENTS` against AGENTS.md → Verification layers and Definition of done. The gate is a script; you run it and report, you do not re-implement it.

1. `pnpm harness:feature show $ARGUMENTS`. If the id is unknown the command lists the candidates; stop and ask.
2. `pnpm harness:verify $ARGUMENTS --dry-run` to see the steps it will run, then `pnpm harness:verify $ARGUMENTS`. The script:
   - runs `L1:`/`L2:`/`L3:` commands in order and stops at the first non-zero exit (AGENTS.md: do not proceed to layer N+1 while layer N fails);
   - refuses to run when a layer needs the project's services (`harness.config.json` → `verify.dockerLayers`, `services`) and they are down, instead of skipping the layer;
   - fails closed on `manual:` steps. Perform the manual check yourself, tell the user what you observed, and only re-run with `--allow-manual` when the user confirms (never in a driver-run session, where `HARNESS_LOOP=1` — a feature with manual steps stays human-run);
   - on success appends `YYYY-MM-DD <command> → pass (commit <sha>)` per step, sets `passing`, bumps `last_updated` and rewrites the file through Prettier.
3. If a layer failed: report the failing command and the relevant output, fix the cause inside the feature's scope, and re-run from step 2. Never edit the `verification` list to make it pass.
4. Report the pass/fail/not-run table the script printed and the evidence lines added. Remind that `/harness:clock-out` still has to update `PROGRESS.md` and commit.

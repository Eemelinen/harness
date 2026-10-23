# Adopting the harness

Two situations: a project without a harness, and a project that still carries a copied harness
(`scripts/harness-*.ts`, `scripts/clean-state-check.sh`, `.claude/hooks/*.sh`, `.claude/skills/clock-*`).
Both end in the same layout. `X.Y.Z` below is the release you install; both pins must name it.

## 1. Prerequisites

- **Node and package manager:** Node ≥ 22.12, pnpm via `packageManager`, `"type": "module"` in
  `package.json`.
- **A single command per layer.** The harness only cares that each command exits 0 or non-zero.
  - L1 is usually `pnpm check` (lint, typecheck, format, unit tests, `pnpm harness:check`).
  - L2/L3 are optional.
- **Commit gates:** `husky`, `lint-staged` and `@commitlint/{cli,config-conventional}` (the
  templates assume them).
- **Machine tools:** git ≥ 2.20, bash (Git Bash on Windows), `claude` (logged in), `gh` for the
  driver, Docker only if a layer needs it.
- **Worktrees contain only committed files.** The driver builds every feature in a fresh worktree:
  - It has no `.env`, no local config and no untracked fixtures, so every layer command must pass
    from committed files. Use a committed, secret-free test env file.
  - Dependencies are installed per worktree by `FAST=1 ./init.sh`.
- **Auto mode.** The driver uses `--permission-mode auto --permission-prompts none`. Without auto
  mode, set `generator.permissionMode` to `dontAsk` or `acceptEdits` and widen `allowedTools`.

## 2. Install

1. **Add the package:**

   ```bash
   pnpm add -D "@eemelinen/harness@github:Eemelinen/harness#vX.Y.Z"
   ```

   pnpm does not run build scripts of git dependencies, and the package needs none: the CLI runs
   its TypeScript through `tsx`, a dependency of the package.

2. **Add the scripts** to `package.json`:

   ```json
   "check": "… && pnpm harness:check",
   "harness:check": "harness check",
   "harness:feature": "harness feature",
   "harness:verify": "harness verify",
   "harness:clean-state": "harness clean-state",
   "harness:loop": "harness loop",
   "harness:report": "harness report",
   "harness:doctor": "harness doctor"
   ```

   lint-staged: `'feature_list.json': ['harness check']`.

3. **Enable the plugin** in `.claude/settings.json`, next to the project's own permissions:

   ```json
   "extraKnownMarketplaces": {
     "eemelinen-harness": {
       "source": { "source": "github", "repo": "Eemelinen/harness", "ref": "vX.Y.Z" }
     }
   },
   "enabledPlugins": { "harness@eemelinen-harness": true }
   ```

   Allow `Bash(pnpm harness:*)` and the layer commands. Deny secrets, generated files and
   destructive commands.

4. **Write `harness.config.json`** ([config.md](config.md)):
   - required: models
   - `allowedTools` for the driver
   - the ticket format and extra feature fields
   - guard rules for the project's generated files, secrets and test runners
   - clean-state checks for skipped tests, coverage thresholds and debug output
   - status lines for the session start
   - `services` (or `null`)

5. **Write the project files** from [../templates/](../templates/):
   - `AGENTS.md`, `PROGRESS.md`, `feature_list.json` (with F-000 bootstrap)
   - `init.sh`, which calls `pnpm harness:doctor` after install
   - `docs/harness/evaluator-rubric.md`, `clean-state-checklist.md`, `session-handoff.md`,
     `quality-document.md`
   - optionally `docs/harness/generator-notes.md`
   - CLAUDE.md: `@AGENTS.md` plus the Claude Code specifics (plugin skills `/harness:clock-in`,
     `/harness:verify-feature`, `/harness:clock-out`, agent `harness:evaluator`, hooks from the plugin)

6. **Gitignore** `.harness/`. Keep `*.sh` at LF in `.gitattributes`.

7. **Trust the folder.** Run `claude` in the repository once and accept the trust dialog and the
   marketplace install. Until then Claude Code ignores the project settings.

### Moving off a copied harness

Do everything above, then:

- **Delete the copies:**
  - `scripts/harness-loop.ts`, `harness-feature.ts`, `harness-events.ts`, `verify-feature.ts`,
    `validate-feature-list.ts`, `clean-state-check.sh`
  - `.claude/hooks/*.sh` that the plugin replaces, and their registrations in `.claude/settings.json`
    (otherwise they run twice)
  - `.claude/skills/{clock-in,clock-out,verify-feature}` and `.claude/agents/evaluator.md`
  - `docs/harness/prompts/`
  - the harness unit tests (`tests/unit/harness/{feature-list,verify-feature,harness-events}.test.ts`).
    `pnpm check` now validates the real feature list through `pnpm harness:check`.
- **Move every project-specific value into `harness.config.json`.** Go through the old copies:
  - from `validate-feature-list.ts`: the ticket regex, and the extra fields with their key order
  - from `guard.sh`: the `case "$rel"` path rules and the project's Bash blocks
  - from `clean-state-check.sh`: the diff checks and marker checks
  - from `session-start.sh`: the status lines
  - from `generator.md`: the spec, design and deviation instructions, into `generatorNotes`
- **Rename references.** `scripts/clean-state-check.sh` → `pnpm harness:clean-state`;
  `/clock-in` → `/harness:clock-in` (likewise the other skills); `evaluator` → `harness:evaluator`.
  Check AGENTS.md, CLAUDE.md, the checklist, the rubric and README.
- **Check that the feature list is unchanged.** `pnpm harness:check`, then write it once (e.g.
  `pnpm harness:feature activate` on a scratch copy with `--file`) and confirm `feature_list.json`
  is byte-identical.
- **Record the change** in `docs/DECISIONS.md` and `PROGRESS.md`.

## 3. Acceptance checks

Run these in order. All must pass.

1. `pnpm install`, then `pnpm harness:doctor` reports no errors and no leftover copies.
2. `pnpm harness:check` prints `feature_list.json OK — …`; `pnpm check` exits 0.
3. `./init.sh` and `FAST=1 ./init.sh` exit 0.
4. Commit, then `pnpm harness:clean-state` exits 0 (all `[ok]` or `[skip]`).
5. The plugin loads.

   ```bash
   claude -p "Reply ok" --output-format stream-json --verbose --max-turns 1 | head -1
   ```

   The init event lists `harness` under `plugins` and the skills `harness:clock-in`,
   `harness:verify-feature`, `harness:clock-out`. A session in the repo prints the session-start
   summary.

6. The guard fires. Feed it a JSON input built with
   `node -e 'console.log(JSON.stringify({tool_name, tool_input}))' | node <plugin>/hooks/guard.mjs`,
   with `CLAUDE_PROJECT_DIR` set. Hand-written JSON with Windows paths usually has broken escapes.
   Check that:
   - `npm install x` is blocked;
   - an edit to `pnpm-lock.yaml` is denied, also with backslash paths;
   - each project path rule decides as configured;
   - with `HARNESS_LOOP=1`, a Write outside the repo and `mkdir -p ~/x` are denied.
7. The commit gates work:
   - a commit with a bad message is rejected by commitlint;
   - a commit with an invalid `feature_list.json` is rejected.
8. `pnpm harness:loop --dry-run --no-docker` passes preflight and prints the worktree and
   `claude` commands for the next ready feature. The commands include `--plugin-dir`.
9. A worktree works with committed files only. Run
   `git worktree add ../check -b check && (cd ../check && FAST=1 ./init.sh && pnpm check)`, then
   remove it.
10. Optional, with a trivial unattended feature: `pnpm harness:loop --once` produces a commit, an
    evaluator verdict and a PR; `pnpm harness:report` shows the run.

## 4. GitHub setup (once per repo, for the driver)

1. **Merge settings.** Settings → General → Pull Requests: enable **Allow auto-merge** and
   **Allow squash merging**.
2. **Run CI once.** Push one commit to the default branch so CI runs. GitHub only offers a check as
   "required" after it has run.
3. **Protect the default branch.** Make the CI job names required checks, with no review
   requirement and admins exempt:

   ```json
   {
     "required_status_checks": { "strict": false, "contexts": ["<job name>"] },
     "enforce_admins": false,
     "required_pull_request_reviews": null,
     "restrictions": null
   }
   ```

   Apply it with `gh api -X PUT repos/<owner>/<repo>/branches/main/protection --input protection.json`.
   Without protection, `merge: "auto"` merges before CI runs.

4. **Log in to GitHub CLI.** `gh auth login`; the token needs `repo` and `workflow`.
5. **Make local verification match CI.** When CI fails on a driver PR, the driver runs a fixer
   session ([how-it-works.md](how-it-works.md#4-operating-the-loop)). That costs a session and a CI
   round. It is cheaper to catch the failure before the PR exists. Every CI step whose settings
   differ from the local layers should have a local twin in L1 or in the clock-out. Example: CI builds
   with `SKIP_ENV_VALIDATION=1` and placeholder env, so add a `build:ci` script that runs the same
   build with the same env. Metsävahti F-048 passed L1–L3 locally and failed exactly that build in CI.

## 5. Prompt for an agent doing the adoption

```text
Adopt the shared agent harness (@eemelinen/harness, https://github.com/Eemelinen/harness) in this
repository at release vX.Y.Z. Read node_modules/@eemelinen/harness/docs/adopting.md after
installing the package, and follow it exactly: inspect the repository first (stack, package manager,
lint / typecheck / test / build / e2e commands, generated files, secrets, services, source and test
directories); define L1/L2/L3 from commands that exist; write harness.config.json, the project files
from templates/ and feature_list.json (F-000 bootstrap with evidence from commands you actually ran,
then the remaining work from <SOURCE>). Run the acceptance checks and fix every failure without
weakening a check. Commit in logical steps with conventional commits whose bodies explain why.
Report what you wrote, the layer commands, the feature count, the acceptance results and the
GitHub steps I must do by hand. Do not run pnpm harness:loop for real.
```

> Implemented in session 002 (F-013…F-016). The living description is [README.md](README.md); this brief is kept as the planning input.

# Phase 2 brief — fully automated feature loop

Input for the next planning session. Phase 1 (commit `091168f`) made the loop _agent-followed_:
a human starts a session and AGENTS.md, the skills and the hooks keep it honest. Phase 2 makes
it _driver-run_: sessions start unattended, one feature per fresh context, until the feature
list is exhausted or a human is needed. Course lectures behind this: L13 ("stop prompting your
agent, design loops") and L14 ("single loop to graph"); primary sources are the Anthropic
"Effective harnesses for long-running agents" and "Harness design for long-running application
development" articles (generator / evaluator roles, context resets, initializer vs coding agent).

## What exists after phase 1 (do not rebuild)

| Subsystem    | Artefact                                                                                                                                                                | Notes                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instructions | `AGENTS.md` (manual, 108 lines, Next.js marker block at the bottom), `CLAUDE.md` (`@AGENTS.md` + Claude notes)                                                          | Constraints carry `why:`/`source:`; clock-in / clock-out routines; definition of done                                                                      |
| State        | `feature_list.json` (13 features, F-000 passing), `PROGRESS.md`, `docs/DECISIONS.md` (D-001…D-007)                                                                      | Schema = course template (`status`, `user_visible_behavior`, `verification[]`, `evidence[]`)                                                               |
| Verification | `pnpm check` (L1), `pnpm test:integration` (L2), `pnpm test:e2e` (L3), `pnpm check:full`, `pnpm harness:check`                                                          | `scripts/validate-feature-list.ts`: WIP=1, evidence-before-passing, `L1:/L2:/L3:/manual:` prefixes; runs from unit tests, lint-staged and the commit guard |
| Scope        | WIP=1 + state machine in AGENTS.md; dependencies only as prose in `notes`                                                                                               | No machine-readable `depends_on` yet                                                                                                                       |
| Lifecycle    | `init.sh`, `docs/harness/{session-handoff,clean-state-checklist,evaluator-rubric,quality-document}.md`                                                                  | Rubric untuned; quality document graded once (2026-09-06)                                                                                                  |
| Claude Code  | `.claude/settings.json` (allow/deny + hooks), `.claude/hooks/{session-start,guard,format}.sh`, skills `clock-in` / `verify-feature` / `clock-out`, subagent `evaluator` | Guard is regex-based on the command text; no Stop hook by design (D-007)                                                                                   |

Verified in phase 1: `pnpm check` green (27 unit tests), `pnpm harness:check`, `FAST=1 ./init.sh`,
all guard cases (block / ask / deny / allow), session-start hook < 1 s, Next's `writeAgentFiles()`
leaves `AGENTS.md` unchanged, PreToolUse guard fired live. **Not yet exercised in a live session:**
the three skills, the `evaluator` subagent, the SessionStart and PostToolUse hooks. First thing to
do in the new conversation: run `/clock-in F-001` and observe them.

## Requirements for the automated loop (dependency order)

1. **Machine-checkable transitions.**
   - `scripts/verify-feature.ts <id>`: runs the feature's `verification[]` in order (L1 → L2 → L3; `manual:` entries fail closed unless `--allow-manual`), appends evidence lines `YYYY-MM-DD <cmd> → pass (commit <hash>)`, sets `passing`, runs prettier + `harness:check`, exit 1 on failure with the failing layer and output.
   - `scripts/clean-state-check.sh`: idempotent clock-out gate (tree clean or only state files, `pnpm harness:check`, `FAST=1 ./init.sh`, no `.only/.skip` added, PROGRESS.md touched this session). Exit 0 only when all pass.
   - Schema additions in `validate-feature-list.ts`: `depends_on: string[]` (validated ids), `attempts: number`, optional `max_attempts`. Rule: `in_progress` only if all `depends_on` are `passing`. Auto-`blocked` after `max_attempts` with the failure summary in `notes`.
   - `scripts/next-feature.ts`: prints the next ready feature id (lowest priority, `not_started`, deps passing) or nothing.
2. **Opt-in Stop hook** (`.claude/hooks/stop-guard.sh`, enabled by `HARNESS_STOP_GUARD=1`): block stopping until `clean-state-check.sh` passes and the active feature is `passing` or `blocked`. Respect `stop_hook_active`; Claude Code caps consecutive blocks at 8 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). Output shape: `{"decision":"block","reason":"…"}` on stdout, exit 0.
3. **Driver** (`scripts/harness/run-loop.sh` or a TS script): per iteration → `next-feature` → create `git worktree` + branch `feat/F-NNN` → run `claude -p` with a fixed prompt ("/clock-in F-NNN … implement … /verify-feature … /clock-out"), `--permission-mode acceptEdits` (or `auto`), `--max-turns`, `--output-format stream-json` saved to `.harness/traces/F-NNN-<ts>.jsonl` → on success open a PR (or merge to `main` if the user decides so) → on failure increment `attempts`, keep the branch for inspection → loop until no ready feature or a stop condition. Alternatives to evaluate in the plan: Agent SDK, scheduled cloud routine (`/schedule`), `/loop`, GitHub Action.
4. **Generator / evaluator split**: after a generator session, run the `evaluator` (fresh context, read-only) on the branch; `Revise` → one bounded retry with the findings appended to the prompt; `Block` → mark the feature `blocked`. Tune the rubric against human judgement over the first 3–5 features (tuning log already in the rubric file).
5. **Isolation and permissions**: worktree per session, never on `main`; the existing deny rules + guard hook remain the safety net; Docker on the host for L2/L3 (`pnpm db:up` once before the loop; e2e uses `.next-e2e` and port 3100, so two e2e sessions cannot run concurrently without parametrising `NEXT_DIST_DIR` and ports).
6. **Observability and termination**: hook-based JSONL trace (SessionStart, PostToolUse for Bash, Stop) into `.harness/traces/` (gitignored); stop conditions: no ready features, N consecutive failures, per-feature turn cap, optional cost cap; notify the user at terminal states (`Notification` hook or PushNotification).
7. **Graph stage (later, L14)**: parallel workers on features with disjoint `area` and satisfied `depends_on`, one worktree each; WIP=1 becomes per-worker (`owner` field on `in_progress` features). Consider Claude Code's Workflow tool for orchestration.

## Decisions the user has to make before building

- Where the driver runs and authenticates: local machine (shell loop, simplest), CI (GitHub Action), or cloud routine.
- Unattended permission posture: `acceptEdits` vs `auto`/`bypassPermissions` (inside a container only).
- Commit policy: PR per feature (recommended) or direct commits to `main`.
- Caps: max attempts per feature, max turns per session, cost budget, wall-clock per session.
- Whether `manual:` verification entries may be waived unattended (recommendation: no; features with manual steps stay human-run).

## Facts verified about Claude Code (2026 docs) that the plan can rely on

- Hook events include `SessionStart` (matchers `startup|resume|clear|compact|fork`), `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionEnd`, `Notification`, `PreCompact`; hook stdin JSON carries `tool_name`, `tool_input`, `stop_hook_active`, `cwd`, `session_id`; exit 2 blocks with stderr shown to Claude; `$CLAUDE_PROJECT_DIR` is available.
- Skills: `.claude/skills/<name>/SKILL.md` with `arguments`, `argument-hint`, `disable-model-invocation`, `allowed-tools`, `context: fork`; `.claude/commands/` is deprecated. Subagents: `.claude/agents/<name>.md` with `tools`, `model`, `permissionMode`, `maxTurns`, `isolation: worktree`.
- Settings precedence: managed > CLI > `.claude/settings.local.json` > `.claude/settings.json` > user; `deny` beats `allow`.
- Source docs: https://code.claude.com/docs/en/hooks.md, …/skills.md, …/sub-agents.md, …/permissions.md, …/memory.md.

## Course references

- Repo: https://github.com/walkinglabs/learn-harness-engineering — templates in `docs/en/resources/templates/`, reference notes in `docs/en/resources/reference/`, skill `skills/harness-creator/` (with `references/lifecycle-bootstrap-pattern.md`, `tool-registry-pattern.md`, `multi-agent-pattern.md`), audit script `tools/audit-harness.sh` (greps for Makefile targets, `templates/`, `PROGRESS.md`; parity is a non-goal per D-007).
- Site: https://walkinglabs.github.io/learn-harness-engineering/

## Suggested opening prompt for the new conversation

"Read `docs/harness/phase-2-automated-loop.md`, `AGENTS.md`, `PROGRESS.md` and `feature_list.json`. Plan phase 2 of the harness (fully automated feature loop) for Claude Code. Decisions: [driver location], [permission mode], [PR vs main], [caps]. Do not implement yet."

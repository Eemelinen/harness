# `harness.config.json`

One file at the project root makes the shared harness fit the project. Every key has a default
except `generator.model` and `evaluator.model`; `pnpm harness:config` prints the resolved values.
Point `$schema` at the shipped schema for completion and validation in the editor:

```json
{ "$schema": "./node_modules/@eemelinen/harness/schema/harness.config.schema.json" }
```

The CLI validates the file with zod and checks that every regular expression compiles. The plugin
hooks read the same file with plain `JSON.parse`, so a hook never fails on a config problem;
`pnpm harness:check`, `pnpm harness:doctor` and the driver do.

Regular expressions are JavaScript syntax inside JSON strings, so a backslash is written twice
(`"\\d"`, `"\\s"`, `"\\."`).

## `project`

| Key             | Default                                                 | Used by                                                                                        |
| --------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `name`          | `"this project"`                                        | Session-start title, driver notifications, generator prompt                                    |
| `defaultBranch` | `"main"`                                                | Driver base branch, clean-state diff base                                                      |
| `remote`        | `"origin"`                                              | Driver push/PR, clean-state diff base (`<remote>/<defaultBranch>`)                             |
| `branchPrefix`  | `"feat/"`                                               | Driver branch names (`feat/F-042`)                                                             |
| `sourceDirs`    | `["src"]`                                               | Session-start warning when source is dirty but the state files are not                         |
| `stateFiles`    | `["feature_list.json", "PROGRESS.md", "docs/harness/"]` | What `clean-state --allow-state-dirty` tolerates; an entry ending in `/` is a directory prefix |
| `featureList`   | `"feature_list.json"`                                   | Every command                                                                                  |
| `progress`      | `"PROGRESS.md"`                                         | Session-start summary, clean-state "updated on this branch" check                              |
| `init`          | `"./init.sh"`                                           | Restart check (`FAST=1`), driver worktree setup                                                |

## `features`

| Key             | Default                   | Meaning                                                                                         |
| --------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `ticketPattern` | `"^[A-Z][A-Z0-9]*-\\d+$"` | The `ticket` field must match.                                                                  |
| `ticketExample` | `"ABC-042"`               | Shown in the error message.                                                                     |
| `extraFields`   | `{}`                      | Project-specific feature fields. A field not declared here is rejected, never silently dropped. |

Each extra field: `type` (`"string"` or `"string[]"`), optional `pattern` and `example`, and `after`
(the key it follows in the written file, default `"spec"`). Metsävahti:

```json
"features": {
  "ticketPattern": "^MV-\\d{3}$",
  "ticketExample": "MV-042",
  "extraFields": {
    "epic": { "pattern": "^E\\d{2}$", "example": "E03", "after": "ticket" },
    "design": { "type": "string[]", "after": "spec" }
  }
}
```

The fixed parts of the schema: ids `F-NNN`; statuses `not_started | in_progress | blocked |
passing`; verification steps prefixed `L1: `, `L2: `, `L3: ` or `manual: `.

## `verify`

| Key            | Default        | Meaning                                                                                                           |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `dockerLayers` | `["L2", "L3"]` | Layers that need `services` up first; `harness verify` refuses to run them otherwise, and their evidence says so. |
| `ciNotes`      | `{}`           | Extra evidence text per layer when `CI` is set, e.g. `{ "L3": "CI=1: next start on the last build, retries 2" }`. |
| `shell`        | `"sh"`         | Verification commands run as `<shell> -c "<command>"` from the project root.                                      |

## `services`

What the service layers need, or `null` when the project has none.

| Key     | Default         | Meaning                                                                       |
| ------- | --------------- | ----------------------------------------------------------------------------- |
| `check` | `"docker info"` | Exit 0 = available. Run by `verify`, the driver preflight.                    |
| `up`    | —               | Run once by the driver preflight, from the main checkout (e.g. `pnpm db:up`). |
| `name`  | `"Docker"`      | Used in messages and evidence (`, Docker available`).                         |

## `milestones`

Test commands the driver log reports as milestones. `pattern` matches where a command starts.
Default: `pnpm check` (L1), `pnpm test:unit` (L1), `pnpm test:integration` (L2),
`pnpm test:e2e` (L3). Activate, verify, clean-state and commits are always milestones.

```json
"milestones": [
  { "pattern": "pnpm check(?:\\s|$)", "label": "L1 pnpm check" },
  { "pattern": "uv run pytest\\b", "label": "L1 pytest" }
]
```

## `guard`

The guard hook's project rules. Core rules always apply: npm/yarn/npx, force push, destructive
git, `rm -rf` outside `rmAllow`, `pnpm-lock.yaml` edits, the commit gate (`harness check`), and in
driver-run sessions `git push`, `checkout main`, worktree commands, home-directory writes and edits
outside the worktree. Core rules skip heredoc bodies the same way as `pattern`.

**`bash`**: rules for Bash commands, checked in order before the core rules; the first hit blocks
the call (exit 2, Claude sees the reason).

| Key                 | Meaning                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `match`             | Repo-relative path glob with shell-`case` semantics: `*` matches any characters including `/`. |
| `decision`          | `deny`, `ask`, or `skip` (stop here without a decision — an exception before a broader rule).  |
| `reason`            | Shown with the decision.                                                                       |
| `tools`             | Only for these tools, e.g. `["Write"]`.                                                        |
| `contentPattern`    | Only when the edited text (old and new strings, or the written content) matches.               |
| `exceptNewOnBranch` | `true`: not for a file this branch added (see below). Default `false`.                         |

With `exceptNewOnBranch`, the rule does not fire for a file missing at the merge base of
`HEAD` and the default branch (`<remote>/<defaultBranch>` first, then `<defaultBranch>`, from
`project`), whether the branch committed it or it is untracked; evaluation moves on to the next
rule. A driver-run session, where `ask` acts as `deny` because nobody answers, can then hand-fix
a migration it generated in the same feature. Files that exist on the default branch are still
guarded. The key also allows writing a brand-new matching file by hand, and it does not cover
renames: a renamed file counts as new under its new name. When git can't tell (no merge base,
git missing, not a repository) the rule fires as usual.

**`rmAllow`** (default `["/tmp/", "node_modules", "coverage"]`): `rm -rf` is allowed when the
command mentions one of these.

```json
"guard": {
  "bash": [
    { "pattern": "(^|[;&|\\s])(npx |pnpm (exec|dlx) )?(vitest|playwright)(\\s|$)",
      "unless": "playwright install|pnpm test", "reason": "run tests through pnpm test:*" },
    { "pattern": "(^|[;&|\\s])pnpm (run )?db:(up|down)", "loopOnly": true,
      "reason": "the loop driver manages the services" }
  ],
  "paths": [
    { "match": "src/migrations/index.ts", "decision": "skip" },
    { "match": "src/migrations/*", "decision": "ask", "reason": "migrations are generated",
      "exceptNewOnBranch": true },
    { "match": ".env", "decision": "deny", "reason": "secrets" }
  ],
  "rmAllow": ["/tmp/", ".next", "coverage", "node_modules"]
}
```

## `cleanState`

Project checks for `harness clean-state`, on top of the core ones (working tree, feature list,
PROGRESS.md updated on the branch, `.env` not tracked, restart path).

**`checks`**: diff checks against the base branch.

| Key       | Meaning                                                                    |
| --------- | -------------------------------------------------------------------------- |
| `name`    | Printed with `[ok]`.                                                       |
| `kind`    | `added` (lines added on the branch plus untracked files) or `removed`.     |
| `paths`   | git pathspecs (`tests`, `src/*.py`, `vitest.config.ts`).                   |
| `pattern` | Regular expression tested per line; diff lines keep their leading `+`/`-`. |
| `message` | Printed with `[FAIL]`.                                                     |

**`files`**: `{ file, mustContain[], name, message }` — the file must contain every string (e.g. a
generated marker block).

## `sessionStart`

`lines`: status lines printed by the session-start hook after the state summary. Each is one of
`{ "file", "present", "missing" }`, `{ "command", "ok", "fail" }` (exit code, 5 s timeout) or
`{ "env", "set", "unset" }`. `hint`: the last line (default: the clock-in pointer).

## `format`

PostToolUse formatter command; the edited file's path is appended. Default
`pnpm exec prettier --write --log-level warn --ignore-unknown`; `null` disables it.

## `prompts`

`generatorNotes`: a project file appended to the driver's generator prompt — how to read the
spec and design, where deviations are recorded, project-specific "never run" rules.

## Driver keys

| Key                                                                                  | Default                                                   | Meaning                                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `caps.maxAttempts / maxTurns / maxBudgetUsd / wallClockMin / maxConsecutiveFailures` | 2 / 200 / 15 / 60 / 2                                     | Per generator session; attempts per feature; failures before the loop stops.                                                                                             |
| `caps.maxCiFixAttempts`                                                              | 2                                                         | CI fixer sessions per auto-merge PR (they use the generator caps), conflict fixers included; `0` gives up on the first red CI or conflict a fixer would have to resolve. |
| `generator.model` (required), `permissionMode`, `effort`                             | — / `auto` / —                                            | The implementing session.                                                                                                                                                |
| `evaluator.model` (required), `effort`, `maxTurns`, `maxBudgetUsd`, `wallClockMin`   | — / — / 60 / 4 / 15                                       | The grading session.                                                                                                                                                     |
| `allowedTools`                                                                       | `[]`                                                      | `--allowedTools` for generator sessions.                                                                                                                                 |
| `worktreeRoot`                                                                       | `../<repo>-worktrees`                                     | One worktree per feature.                                                                                                                                                |
| `merge`                                                                              | `"wait"`                                                  | `auto` (needs branch protection), `wait` (a human merges), `none`.                                                                                                       |
| `reviewPaths`                                                                        | `.claude/*`, `.github/workflows/*`, `harness.config.json` | Globs (`*` crosses `/`). A loop PR that changes one goes through the merge gate ([self-improvement.md](self-improvement.md#safety-the-merge-gate)).                      |
| `review.mode`                                                                        | `"evaluate"`                                              | `evaluate`: hard stops wait for a human, otherwise a safety review session decides and `safe` auto-merges. `human`: always wait.                                         |
| `review.model`, `effort`, `maxTurns`, `maxBudgetUsd`, `wallClockMin`                 | `evaluator.model` / — / 30 / 2 / 15                       | The read-only safety review session.                                                                                                                                     |
| `retro.every`, `retro.onQueueEmpty`, `retro.maxPerLoop`                              | 0 / `false` / 3                                           | When the loop runs a retro: after every N features, when the queue is empty, at most this many per loop run.                                                             |
| `retro.intake`                                                                       | `false`                                                   | Turn this repository's open `harness-retro` issues into features before the feature list's own.                                                                          |
| `retro.intakeLabel`                                                                  | —                                                         | Take only retro issues that also carry this label (a triage gate, e.g. `updater:accepted`).                                                                              |
| `retro.harnessRepo`, `retro.label`                                                   | the package's repository / `harness-retro`                | Where harness findings are filed; the issue label.                                                                                                                       |
| `retro.model`, `effort`, `maxTurns`, `maxBudgetUsd`, `wallClockMin`                  | `evaluator.model` / — / 40 / 3 / 20                       | The read-only analysis session.                                                                                                                                          |
| `update.auto`                                                                        | `false`                                                   | Before each feature, move to the newest harness release through a driver-made update PR, then restart the driver on it.                                                  |
| `update.allowBreaking`                                                               | `false`                                                   | Also take a breaking release (new major; new minor while 0.x). Off: notify instead.                                                                                      |
| `update.canary`                                                                      | `true`                                                    | This project may be the first to test a release (claim it on its rollout issue). `false`: take only releases a canary verified.                                          |
| `update.canaryHours`                                                                 | 4                                                         | How long a canary claim lasts without renewal; the canary renews it every 30 min while it tests.                                                                         |
| `traceDir`, `runsLog`                                                                | `.harness/traces`, `.harness/runs.jsonl`                  | Gitignore `.harness/`.                                                                                                                                                   |

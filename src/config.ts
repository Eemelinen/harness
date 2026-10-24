/**
 * `harness.config.json`: the one file that makes the shared harness fit a project. Every value a
 * project used to hard-code in its copy of the scripts and hooks (ticket format, guard rules,
 * clean-state checks, layer commands, services, models, caps) lives here. Docs: docs/config.md.
 *
 * The plugin hooks read the same file with plain `JSON.parse` (they run from the plugin cache
 * without dependencies), so every key below has a default and a missing section is never an error.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

export const CONFIG_FILE = 'harness.config.json'

const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
const layer = z.enum(['L1', 'L2', 'L3'])

const bashRule = z.object({
  /** JavaScript regular expression tested against the whole Bash command. */
  pattern: z.string().min(1),
  /** The rule does not fire when this expression also matches. */
  unless: z.string().min(1).optional(),
  /**
   * Match only where a command starts (string start or after `;`, `&`, `|`, `(`), so a heredoc
   * or commit message line beginning with the same word is not mistaken for a command.
   */
  atCommandStart: z.boolean().default(false),
  /** Only in driver-run sessions (`HARNESS_LOOP=1`). */
  loopOnly: z.boolean().default(false),
  reason: z.string().min(1),
})

const pathRule = z.object({
  /** Repo-relative glob with forward slashes (`*` within a segment, `**` across segments). */
  match: z.string().min(1),
  /** `skip` ends rule evaluation without a decision (an exception before a broader rule). */
  decision: z.enum(['deny', 'ask', 'skip']),
  reason: z.string().default(''),
  /** Limit the rule to these tools (default: Edit, Write and MultiEdit). */
  tools: z.array(z.enum(['Edit', 'Write', 'MultiEdit'])).optional(),
  /** Only when the edit's old/new text or the written content matches this expression. */
  contentPattern: z.string().min(1).optional(),
})

const diffCheck = z.object({
  /** Printed with [ok] when the check passes. */
  name: z.string().min(1),
  /** `added`: lines added on the branch (plus untracked files); `removed`: lines removed. */
  kind: z.enum(['added', 'removed']),
  /** git pathspecs, e.g. `tests`, `src/*.py`, `vitest.config.ts`. */
  paths: z.array(z.string().min(1)).min(1),
  /** JavaScript regular expression tested per line. */
  pattern: z.string().min(1),
  /** Printed with [FAIL] when a line matches. */
  message: z.string().min(1),
})

const fileCheck = z.object({
  file: z.string().min(1),
  mustContain: z.array(z.string().min(1)).min(1),
  name: z.string().min(1),
  message: z.string().min(1),
})

const statusLine = z.union([
  z.object({ file: z.string().min(1), present: z.string(), missing: z.string() }),
  z.object({ command: z.string().min(1), ok: z.string(), fail: z.string() }),
  z.object({ env: z.string().min(1), set: z.string(), unset: z.string().default('') }),
])

const extraField = z.object({
  type: z.enum(['string', 'string[]']).default('string'),
  pattern: z.string().min(1).optional(),
  example: z.string().optional(),
  /** Key the field follows in the written file (default: `spec`). */
  after: z.string().min(1).default('spec'),
})

export const configSchema = z.object({
  $schema: z.string().optional(),
  $comment: z.string().optional(),
  project: z
    .object({
      /** Display name: session-start title, notifications, prompts. */
      name: z.string().min(1).default('this project'),
      defaultBranch: z.string().min(1).default('main'),
      remote: z.string().min(1).default('origin'),
      branchPrefix: z.string().min(1).default('feat/'),
      /** Source directories: uncommitted changes here without state-file changes mean a session ended without clock-out. */
      sourceDirs: z.array(z.string().min(1)).default(['src']),
      /** Files and directory prefixes `clean-state --allow-state-dirty` tolerates uncommitted. */
      stateFiles: z
        .array(z.string().min(1))
        .default(['feature_list.json', 'PROGRESS.md', 'docs/harness/']),
      featureList: z.string().min(1).default('feature_list.json'),
      progress: z.string().min(1).default('PROGRESS.md'),
      /** The standard startup path; the restart check runs it with FAST=1. */
      init: z.string().min(1).default('./init.sh'),
    })
    .prefault({}),
  features: z
    .object({
      ticketPattern: z.string().min(1).default('^[A-Z][A-Z0-9]*-\\d+$'),
      ticketExample: z.string().min(1).default('ABC-042'),
      /** Project-specific feature fields, e.g. `epic` or `design`. Unknown fields are rejected. */
      extraFields: z.record(z.string().min(1), extraField).default({}),
    })
    .prefault({}),
  verify: z
    .object({
      /** Layers that need `services.check` to pass first; their evidence says so. */
      dockerLayers: z.array(layer).default(['L2', 'L3']),
      /** Extra evidence text per layer when `CI` is set, e.g. how Playwright runs in CI. */
      ciNotes: z.partialRecord(layer, z.string().min(1)).default({}),
      /** Shell used for verification commands (they are written for POSIX sh). */
      shell: z.string().min(1).default('sh'),
    })
    .prefault({}),
  /** Bash commands the loop log reports as test milestones (the pattern matches at command start). */
  milestones: z.array(z.object({ pattern: z.string().min(1), label: z.string().min(1) })).default([
    { pattern: 'pnpm check(?:\\s|$)', label: 'L1 pnpm check' },
    { pattern: 'pnpm test:unit\\b', label: 'L1 test:unit' },
    { pattern: 'pnpm test:integration\\b', label: 'L2 test:integration' },
    { pattern: 'pnpm test:e2e\\b', label: 'L3 test:e2e' },
  ]),
  /** Background services L2/L3 need; `null` when the project has none. */
  services: z
    .object({
      check: z.string().min(1).default('docker info'),
      up: z.string().min(1).optional(),
      /** Shown when the check fails. */
      name: z.string().min(1).default('Docker'),
    })
    .nullable()
    .prefault({}),
  guard: z
    .object({
      bash: z.array(bashRule).default([]),
      paths: z.array(pathRule).default([]),
      /** `rm -rf` is allowed when the command mentions one of these. */
      rmAllow: z.array(z.string().min(1)).default(['/tmp/', 'node_modules', 'coverage']),
    })
    .prefault({}),
  cleanState: z
    .object({
      checks: z.array(diffCheck).default([]),
      files: z.array(fileCheck).default([]),
    })
    .prefault({}),
  sessionStart: z
    .object({
      lines: z.array(statusLine).default([]),
      hint: z.string().optional(),
    })
    .prefault({}),
  /** PostToolUse formatter; the edited file's path is appended. `null` disables it. */
  format: z
    .string()
    .min(1)
    .nullable()
    .default('pnpm exec prettier --write --log-level warn --ignore-unknown'),
  prompts: z
    .object({
      /** Project file appended to the generator prompt (spec/design reading, deviation ledger, …). */
      generatorNotes: z.string().min(1).optional(),
    })
    .prefault({}),
  caps: z
    .object({
      maxAttempts: z.number().int().positive().default(2),
      maxTurns: z.number().int().positive().default(200),
      maxBudgetUsd: z.number().positive().default(15),
      wallClockMin: z.number().positive().default(60),
      maxConsecutiveFailures: z.number().int().positive().default(2),
      /** Fixer sessions per PR after a failed CI check on an auto-merge PR; 0 gives up at once. */
      maxCiFixAttempts: z.number().int().nonnegative().default(2),
    })
    .prefault({}),
  generator: z.object({
    model: z.string().min(1),
    permissionMode: z.enum(['auto', 'acceptEdits', 'dontAsk', 'bypassPermissions']).default('auto'),
    effort: effort.optional(),
  }),
  evaluator: z.object({
    model: z.string().min(1),
    effort: effort.optional(),
    maxTurns: z.number().int().positive().default(60),
    maxBudgetUsd: z.number().positive().default(4),
    wallClockMin: z.number().positive().default(15),
  }),
  allowedTools: z.array(z.string().min(1)).default([]),
  /** Where the driver creates one worktree per feature (default `../<repo>-worktrees`). */
  worktreeRoot: z.string().min(1).optional(),
  merge: z.enum(['wait', 'auto', 'none']).default('wait'),
  /**
   * Repo-relative globs (`*` matches across `/`) of files that change what sessions may do or what
   * gets verified. A loop PR that touches one goes through `review` before it may auto-merge
   * (docs/self-improvement.md → Safety). Add project hooks that live elsewhere.
   */
  reviewPaths: z
    .array(z.string().min(1))
    .default(['.claude/*', '.github/workflows/*', 'harness.config.json']),
  /** How a PR that needs review merges: `evaluate` (a safety review decides) or `human`. */
  review: z
    .object({
      mode: z.enum(['evaluate', 'human']).default('evaluate'),
      /** The safety-review session; the model defaults to `evaluator.model`. */
      model: z.string().min(1).optional(),
      effort: effort.optional(),
      maxTurns: z.number().int().positive().default(30),
      maxBudgetUsd: z.number().positive().default(2),
      wallClockMin: z.number().positive().default(15),
    })
    .prefault({}),
  /** Moving to a newer harness release (`harness update`, docs/how-it-works.md → Operating). */
  update: z
    .object({
      /** Before each feature, the loop moves to the newest release through its own update PR. */
      auto: z.boolean().default(false),
      /** Also take a breaking release (a new major version; a new minor version while 0.x). */
      allowBreaking: z.boolean().default(false),
      /**
       * This project may be the first to test a release (the canary, src/rollout.ts); `false`
       * takes only releases another project verified.
       */
      canary: z.boolean().default(true),
      /** How long a canary's claim on a release lasts without renewal. */
      canaryHours: z.number().positive().default(4),
    })
    .prefault({}),
  /** The loop's look back at its own runs (`harness retro`, docs/self-improvement.md). */
  retro: z
    .object({
      /** Run a retro after this many features in one loop run; 0 never does. */
      every: z.number().int().nonnegative().default(0),
      /** Run a retro when the queue is empty and features ran since the last one. */
      onQueueEmpty: z.boolean().default(false),
      /** Turn open retro issues of this repository into features before the feature list's own. */
      intake: z.boolean().default(false),
      /** Retros per loop run, so retro fixes cannot keep the loop busy with retros. */
      maxPerLoop: z.number().int().positive().default(3),
      /** GitHub `owner/name` that gets harness findings (default: the package's repository). */
      harnessRepo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/)
        .optional(),
      label: z.string().min(1).default('harness-retro'),
      /** Analysis session; the model defaults to `evaluator.model`. */
      model: z.string().min(1).optional(),
      effort: effort.optional(),
      maxTurns: z.number().int().positive().default(40),
      maxBudgetUsd: z.number().positive().default(3),
      wallClockMin: z.number().positive().default(20),
    })
    .prefault({}),
  traceDir: z.string().min(1).default('.harness/traces'),
  runsLog: z.string().min(1).default('.harness/runs.jsonl'),
})

export type HarnessConfig = z.infer<typeof configSchema>
export type ConfigInput = z.input<typeof configSchema>

/** Parse a raw config; throws with a readable report on failure. */
export function parseConfig(raw: unknown): HarnessConfig {
  const result = configSchema.safeParse(raw)
  if (!result.success)
    throw new Error(`${CONFIG_FILE} is invalid:\n${z.prettifyError(result.error)}`)
  for (const [where, source] of regexSources(result.data)) {
    try {
      new RegExp(source)
    } catch (error) {
      throw new Error(
        `${CONFIG_FILE}: ${where} is not a valid regular expression: ${String(error)}`,
      )
    }
  }
  return result.data
}

function regexSources(config: HarnessConfig): [string, string][] {
  const out: [string, string][] = [['features.ticketPattern', config.features.ticketPattern]]
  for (const [name, field] of Object.entries(config.features.extraFields))
    if (field.pattern) out.push([`features.extraFields.${name}.pattern`, field.pattern])
  config.milestones.forEach((m, i) => out.push([`milestones[${i}].pattern`, m.pattern]))
  config.guard.bash.forEach((r, i) => {
    out.push([`guard.bash[${i}].pattern`, r.pattern])
    if (r.unless) out.push([`guard.bash[${i}].unless`, r.unless])
  })
  config.guard.paths.forEach((r, i) => {
    if (r.contentPattern) out.push([`guard.paths[${i}].contentPattern`, r.contentPattern])
  })
  config.cleanState.checks.forEach((c, i) =>
    out.push([`cleanState.checks[${i}].pattern`, c.pattern]),
  )
  return out
}

/**
 * The project root: the nearest directory at or above `from` that holds `harness.config.json`.
 * A driver worktree has its own copy, so commands run inside it resolve to the worktree.
 */
export function findRoot(from: string = process.cwd()): string {
  let dir = path.resolve(from)
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return dir
    const parent = path.dirname(dir)
    if (parent === dir)
      throw new Error(`no ${CONFIG_FILE} found in ${path.resolve(from)} or any parent directory`)
    dir = parent
  }
}

export interface Project {
  root: string
  config: HarnessConfig
  /** Absolute path of a repo-relative path. */
  resolve: (...segments: string[]) => string
}

export function loadProject(from: string = process.cwd()): Project {
  const root = findRoot(from)
  const raw: unknown = JSON.parse(readFileSync(path.join(root, CONFIG_FILE), 'utf8'))
  const config = parseConfig(raw)
  return { root, config, resolve: (...segments) => path.resolve(root, ...segments) }
}

export function worktreeRoot(project: Project): string {
  return project.resolve(
    project.config.worktreeRoot ?? `../${path.basename(project.root)}-worktrees`,
  )
}

/**
 * Loop driver: runs one fresh `claude -p` session per ready feature in its own git worktree,
 * re-checks the result deterministically, has a fresh-context evaluator grade it, opens a PR
 * and moves on (docs/README.md → Driver-run sessions).
 *
 *   harness loop                 loop until no feature is ready or a stop condition hits
 *   harness loop --once          exactly one feature
 *   harness loop --feature F-042 this feature (must be ready)
 *   harness loop --dry-run       print worktree commands and claude invocations, run nothing
 *   harness loop --auto-merge    gh pr merge --auto --squash instead of waiting for a human
 *   harness loop --no-wait       do not wait for the merge; continue with independent features
 *   harness loop --no-docker     skip the services preflight (unit-only features)
 *   harness report               table of past runs (runsLog)
 *
 * Every session gets the harness plugin from the installed package through `--plugin-dir`, so
 * the guard, Stop hook and skills match the pinned package version and do not depend on the
 * folder being trusted. A session whose init event does not list the plugin is stopped at once:
 * an unattended session without the guard must not run.
 *
 * With `update.auto`, before each feature the driver moves to the harness release pickTarget chooses
 * (src/update.ts: old enough, not breaking, not quarantined) through its own pin-only PR, after the
 * new version's selftest showed no regression; then it restarts itself on that version. See
 * maybeUpdate and pinPr. The first feature on the new version runs on probation: if it does not
 * pass, the run is set aside, the pins roll back and the feature runs again on the old version,
 * which quarantines the release when it passes there. The previous driver waits for the restarted
 * one and rolls back when it crashes before that (supervise).
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

import {
  decideCiFix,
  describeChecks,
  isFailed,
  logExcerpt,
  parseChecks,
  parseFixVerdict,
  runIds,
  type CiCheck,
} from './ci'
import { cleanState } from './clean-state'
import { CONFIG_FILE, loadProject, worktreeRoot, type HarnessConfig, type Project } from './config'
import { doctor, packageVersion } from './doctor'
import { describeEvent, heartbeat, newStreamState } from './events'
import {
  FEATURE_ID,
  isHumanOnly,
  isReady,
  nextReadyFeature,
  readFeatureList,
  today,
  writeFeatureList,
  type Feature,
} from './feature-list'
import {
  countFeatureRun,
  markQueued,
  nextIntake,
  readRetroState,
  reviewReasons,
  runRetro,
  type IntakeItem,
} from './retro'
import { hardStops, parseSafetyVerdict, type SafetyVerdict, type Snapshot } from './review'
import { PACKAGE_ROOT, sh as run, shellLine } from './run'
import { quarantine } from './quarantine'
import { regressions, type Check } from './selftest'
import {
  applyUpdate,
  compareVersions,
  installedBin,
  isHarnessRepo,
  listQuarantined,
  listReleases,
  notPinOnly,
  PACKAGE,
  pickTarget,
  pinSpec,
  rolloutRepo,
  type PinSnapshot,
  type Target,
} from './update'

export const PLUGIN_NAME = 'harness'

interface Options {
  once: boolean
  feature?: string
  dryRun: boolean
  autoMerge: boolean
  wait: boolean
  services: boolean
}

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

let project: Project
let config: HarnessConfig
let ROOT: string

/** Human-readable log of the current feature (`<traceDir>/F-NNN-<time>.log`), next to the traces. */
let logFile: string | undefined

const log = (line: string) => {
  const stamped = `[harness ${new Date().toISOString().slice(11, 19)}] ${line}`
  console.log(stamped)
  if (logFile) appendFileSync(logFile, `${stamped}\n`)
}

const sh = (
  command: string,
  args: string[],
  opts: { cwd?: string; quiet?: boolean; env?: Record<string, string | undefined> } = {},
) => run(command, args, { ...opts, cwd: opts.cwd ?? ROOT })

function must(cmd: string, args: string[], what: string, cwd?: string): string {
  const r = sh(cmd, args, { cwd, quiet: true })
  if (r.code !== 0) throw new Error(`${what} failed (${cmd} ${args.join(' ')}): ${r.err || r.out}`)
  return r.out
}

function notify(message: string) {
  if (process.platform === 'darwin') {
    sh(
      'osascript',
      [
        '-e',
        `display notification ${JSON.stringify(message)} with title ${JSON.stringify(`${config.project.name} harness`)}`,
      ],
      { quiet: true },
    )
  }
  log(`NOTIFY: ${message}`)
}

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '')
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

const defaultBranch = () => config.project.defaultBranch
const remote = () => config.project.remote

// ---------------------------------------------------------------------------------------
// Claude sessions
// ---------------------------------------------------------------------------------------

interface ClaudeResult {
  exitCode: number
  timedOut: boolean
  /** The session's init event did not list the harness plugin; it was stopped. */
  pluginMissing: boolean
  /** The final `result` message of the stream with every segment's turns (or the single JSON result). */
  result?: Record<string, unknown>
}

interface ClaudeRun {
  cwd: string
  args: string[]
  env: Record<string, string | undefined>
  traceFile: string
  wallClockMs: number
  stream: boolean
}

/**
 * A stream-json session emits one `result` per segment: a wakeup or a background-task
 * notification resumes it and ends in another. `num_turns` counts only that segment, while
 * `total_cost_usd` and `modelUsage` are session totals, so the turns are summed and everything
 * else comes from the last segment.
 */
export function mergeResult(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (!prev) return next
  return { ...next, num_turns: Number(prev.num_turns ?? 0) + Number(next.num_turns ?? 0) }
}

let currentChild: ReturnType<typeof spawn> | undefined
let aborting = false

function runClaude(runSpec: ClaudeRun): Promise<ClaudeResult> {
  mkdirSync(path.dirname(runSpec.traceFile), { recursive: true })
  const trace = createWriteStream(runSpec.traceFile, { flags: 'a' })
  return new Promise((resolve) => {
    const child = spawn('claude', runSpec.args, {
      cwd: runSpec.cwd,
      env: { ...process.env, ...runSpec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    currentChild = child
    let timedOut = false
    let pluginMissing = false
    let buffer = ''
    let result: Record<string, unknown> | undefined
    let raw = ''

    const timer = setTimeout(() => {
      timedOut = true
      log(`wall clock exceeded (${runSpec.wallClockMs / 60000} min): sending SIGINT`)
      child.kill('SIGINT')
      setTimeout(() => child.kill('SIGTERM'), 30_000).unref()
    }, runSpec.wallClockMs)

    const state = newStreamState(runSpec.cwd, Date.now(), config.milestones)
    const beat = runSpec.stream ? setInterval(() => log(heartbeat(state)), 5 * 60_000) : undefined

    const handleLine = (line: string) => {
      if (!line.trim()) return
      trace.write(`${line}\n`)
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        return // non-JSON line (e.g. a warning); kept in the trace
      }
      if (msg.type === 'result') result = mergeResult(result, msg)
      for (const out of describeEvent(msg, state)) log(out)
      if (
        msg.type === 'system' &&
        msg.subtype === 'init' &&
        !state.plugins?.includes(PLUGIN_NAME)
      ) {
        pluginMissing = true
        log(
          `the ${PLUGIN_NAME} plugin is not loaded (guard and Stop hook missing): stopping the session`,
        )
        child.kill('SIGTERM')
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (!runSpec.stream) {
        raw += chunk.toString()
        trace.write(chunk)
        return
      }
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      // A JSON result file (evaluator) must stay parseable; stderr goes to the readable log.
      if (runSpec.stream) trace.write(`[stderr] ${chunk.toString()}`)
      for (const line of chunk.toString().split('\n'))
        if (line.trim()) log(`stderr: ${line.trim().slice(0, 300)}`)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (beat) clearInterval(beat)
      currentChild = undefined
      if (runSpec.stream && buffer) handleLine(buffer)
      if (!runSpec.stream && raw.trim()) {
        try {
          result = JSON.parse(raw) as Record<string, unknown>
        } catch {
          result = { type: 'result', is_error: true, result: raw }
        }
      }
      trace.end()
      resolve({ exitCode: code ?? 1, timedOut, pluginMissing, result })
    })
  })
}

function describeResult(r: ClaudeResult): string {
  const res = r.result ?? {}
  const denials = Array.isArray(res.permission_denials) ? res.permission_denials.length : 0
  return `exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''} · subtype ${String(res.subtype ?? '?')} · turns ${String(
    res.num_turns ?? '?',
  )} · cost $${Number(res.total_cost_usd ?? 0).toFixed(2)} · denials ${denials}`
}

/**
 * The plugin of the harness version installed in `dir` (a worktree may pin a newer one). In the
 * harness repository the package resolves to the worktree itself; its sessions must not run the
 * hooks they are editing, so they get the plugin of the checkout the driver runs from.
 */
export function pluginDir(dir: string, driverRoot: string = PACKAGE_ROOT): string {
  try {
    const require = createRequire(path.join(dir, 'package.json'))
    const root = path.dirname(require.resolve('@eemelinen/harness/package.json'))
    if (path.resolve(root) === path.resolve(dir)) return path.join(driverRoot, 'plugin')
    return path.join(root, 'plugin')
  } catch {
    return path.join(driverRoot, 'plugin')
  }
}

// ---------------------------------------------------------------------------------------
// Git / worktree / GitHub
// ---------------------------------------------------------------------------------------

function branchFor(id: string) {
  return `${config.project.branchPrefix}${id}`
}

/**
 * The notice when nothing is ready. A branch whose feature is already passing on the default
 * branch is a leftover of a merged PR (a merge before delete-branch-on-merge was on), not work in
 * flight, so it is named separately for a human to delete.
 */
export function queueEmptyNotice(
  inFlight: string[],
  list: { features: Pick<Feature, 'id' | 'status'>[] },
  branchPrefix: string,
): string {
  const passing = new Set(list.features.filter((f) => f.status === 'passing').map((f) => f.id))
  const open = inFlight.filter((id) => !passing.has(id))
  const stale = inFlight.filter((id) => passing.has(id))
  let notice = 'queue empty'
  if (open.length)
    notice += ` (${open.join(', ')} in flight — merge their PRs to unblock dependents)`
  if (stale.length)
    notice += `; leftover branches of passing features, safe to delete: ${stale.map((id) => `${branchPrefix}${id}`).join(', ')}`
  return notice
}

function worktreePath(id: string) {
  return path.join(worktreeRoot(project), id)
}

function remoteBranches(): string[] {
  const r = sh('git', ['ls-remote', '--heads', remote(), `refs/heads/${branchFor('F-*')}`], {
    quiet: true,
  })
  if (r.code !== 0) return []
  return r.out
    .split('\n')
    .map((line) => line.split('\t')[1] ?? '')
    .filter(Boolean)
    .map((ref) => ref.replace('refs/heads/', ''))
}

/** Feature ids whose branch exists on the remote (open or unmerged PR) or locally. */
function inFlightIds(): string[] {
  const local = sh('git', ['branch', '--list', branchFor('F-*'), '--format=%(refname:short)'], {
    quiet: true,
  }).out
  const names = new Set([...remoteBranches(), ...local.split('\n').filter(Boolean)])
  return [...names]
    .map((b) => b.slice(config.project.branchPrefix.length))
    .filter((id) => FEATURE_ID.test(id))
}

function ensureWorktree(id: string, dryRun: boolean): string {
  const dir = worktreePath(id)
  const branch = branchFor(id)
  const branchExists =
    sh('git', ['rev-parse', '--verify', '--quiet', branch], { quiet: true }).code === 0
  const cmd = branchExists
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '-b', branch, dir, defaultBranch()]
  if (dryRun) {
    log(`would run: git ${cmd.join(' ')}`)
    log(`would run: (cd ${dir} && FAST=1 ${config.project.init})`)
    return dir
  }
  if (!existsSync(dir)) {
    mkdirSync(path.dirname(dir), { recursive: true })
    must('git', cmd, 'git worktree add')
    log(`worktree ${dir} on ${branch}`)
  } else {
    log(`reusing worktree ${dir}`)
  }
  const init = sh('bash', [config.project.init], { cwd: dir, env: { FAST: '1' } })
  if (init.code !== 0) throw new Error(`FAST=1 ${config.project.init} failed in ${dir}`)
  return dir
}

function removeWorktree(id: string) {
  const dir = worktreePath(id)
  sh('git', ['worktree', 'remove', '--force', dir], { quiet: true })
  sh('git', ['branch', '-D', branchFor(id)], { quiet: true })
}

function ghAvailable(): boolean {
  return sh('gh', ['auth', 'status'], { quiet: true }).code === 0
}

// ---------------------------------------------------------------------------------------
// Post-checks
// ---------------------------------------------------------------------------------------

interface PostCheck {
  ok: boolean
  status: Feature['status'] | 'missing'
  feature?: Feature
  problems: string[]
  /** Commits on the feature branch that are not on the default branch. */
  ahead: number
}

function postCheck(dir: string, id: string): PostCheck {
  const problems: string[] = []
  let feature: Feature | undefined
  let status: PostCheck['status'] = 'missing'
  let worktree: Project | undefined
  try {
    worktree = loadProject(dir)
    const list = readFeatureList(
      worktree.resolve(worktree.config.project.featureList),
      worktree.config.features,
    )
    feature = list.features.find((f) => f.id === id)
    status = feature?.status ?? 'missing'
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  if (status !== 'passing' && status !== 'blocked')
    problems.push(`feature is ${status}, expected passing or blocked`)
  if (worktree) {
    const clean = cleanState(worktree, {
      quick: true,
      requireTerminal: true,
      base: defaultBranch(),
    })
    problems.push(...clean.lines.filter((l) => l.status === 'fail').map((l) => `[FAIL] ${l.text}`))
  }
  const ahead = Number(
    sh('git', ['rev-list', '--count', `${defaultBranch()}..HEAD`], { cwd: dir, quiet: true }).out ||
      0,
  )
  if (ahead === 0) problems.push('no commits on the branch')
  return { ok: problems.length === 0, status, feature, problems, ahead }
}

// ---------------------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------------------

interface Verdict {
  verdict: 'Accept' | 'Revise' | 'Block'
  scores: Record<string, number>
  findings: { severity: string; file?: string; line?: number; note: string }[]
  required_follow_up: string[]
}

export function parseVerdict(result: Record<string, unknown> | undefined): Verdict | undefined {
  const structured = result?.structured_output as Verdict | undefined
  if (structured?.verdict) return structured
  const text = typeof result?.result === 'string' ? result.result : ''
  const match = /Verdict:\s*(Accept|Revise|Block)/i.exec(text)
  if (!match) return undefined
  const verdict = (match[1]?.[0]?.toUpperCase() ?? '') + (match[1]?.slice(1).toLowerCase() ?? '')
  return {
    verdict: verdict as Verdict['verdict'],
    scores: {},
    findings: [{ severity: 'major', note: text.slice(0, 12_000) }],
    required_follow_up: [],
  }
}

/**
 * The evaluator agent's instructions and tools from the plugin's `agents/evaluator.md`. The driver
 * passes them with `--append-system-prompt` / `--tools` instead of `--agent`, because
 * `claude -p --agent` ignores `--json-schema` and returns prose.
 */
export function evaluatorAgent(plugin: string): { instructions: string; tools: string } {
  const text = readFileSync(path.join(plugin, 'agents', 'evaluator.md'), 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`${plugin}/agents/evaluator.md has no frontmatter`)
  const tools = /^tools:\s*(.+)$/m.exec(match[1] ?? '')?.[1] ?? 'Read, Glob, Grep, Bash'
  return {
    instructions: (match[2] ?? '').trim(),
    tools: tools
      .split(',')
      .map((t) => t.trim())
      .join(','),
  }
}

/** Score line plus one line per finding, for the console and the readable log. */
function verdictLines(v: Verdict): string[] {
  const scores = Object.entries(v.scores)
    .map(([k, s]) => `${k} ${s}`)
    .join(' · ')
  return [
    `verdict ${v.verdict}${scores ? ` — ${scores}` : ' (unstructured)'}`,
    ...v.findings.map(
      (f) =>
        `${f.severity}${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : ''}: ${f.note.replace(/\s+/g, ' ').slice(0, 200)}`,
    ),
    ...v.required_follow_up.map((s) => `follow-up: ${s.replace(/\s+/g, ' ').slice(0, 200)}`),
  ]
}

function verdictMarkdown(v: Verdict): string {
  const rows = Object.entries(v.scores)
    .map(([k, s]) => `| ${k} | ${s} |`)
    .join('\n')
  const findings = v.findings
    .map(
      (f) =>
        `- **${f.severity}** ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` ` : ''}${f.note}`,
    )
    .join('\n')
  const follow = v.required_follow_up.map((s) => `- ${s}`).join('\n')
  return `### Evaluator verdict: ${v.verdict}\n\n| Category | Score |\n| --- | --- |\n${rows || '| (unstructured) | – |'}\n\n${findings || '_no findings_'}\n\n${follow ? `Required follow-up:\n${follow}` : ''}`
}

/**
 * One evaluator session: fresh context, read-only. `--agent` ignores `--json-schema`, so the
 * agent file's instructions and tool list are passed directly (see evaluatorAgent()).
 */
async function runEvaluator(
  id: string,
  feature: Feature,
  dir: string,
  plugin: string,
  context = '',
): Promise<{ verdict?: Verdict; cost: number }> {
  log(`=== ${id}: evaluator session (${config.evaluator.model})`)
  const agent = evaluatorAgent(plugin)
  const evalArgs = [
    '-p',
    render(promptFile('evaluator.md'), {
      FEATURE_ID: id,
      FEATURE_TITLE: feature.title,
      BASE: `${remote()}/${defaultBranch()}`,
      CONTEXT: context,
    }),
    '--plugin-dir',
    plugin,
    '--append-system-prompt',
    agent.instructions,
    '--tools',
    agent.tools,
    '--permission-mode',
    config.generator.permissionMode,
    '--permission-prompts',
    'none',
    '--max-turns',
    String(config.evaluator.maxTurns),
    '--max-budget-usd',
    String(config.evaluator.maxBudgetUsd),
    '--model',
    config.evaluator.model,
    ...(config.evaluator.effort ? ['--effort', config.evaluator.effort] : []),
    '--output-format',
    'json',
    '--json-schema',
    promptFile('evaluator-schema.json'),
  ]
  const ev = await runClaude({
    cwd: dir,
    args: evalArgs,
    env: { HARNESS_LOOP: '1' },
    traceFile: path.join(ROOT, config.traceDir, `${id}-${stamp()}.evaluator.json`),
    wallClockMs: config.evaluator.wallClockMin * 60_000,
    stream: false,
  })
  const verdict = parseVerdict(ev.result)
  log(`evaluator finished: ${describeResult(ev)} → ${verdict?.verdict ?? 'no verdict'}`)
  if (verdict) for (const line of verdictLines(verdict)) log(`  ${line}`)
  return { verdict, cost: Number(ev.result?.total_cost_usd ?? 0) }
}

// ---------------------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------------------

interface RunRecord {
  ts: string
  feature: string
  attempt: number
  outcome:
    | 'pr'
    | 'merged'
    | 'blocked'
    | 'failed'
    | 'aborted'
    | 'pushed'
    | 'ci-fix'
    | 'ci-rerun'
    | 'retro'
    | 'updated'
    | 'rolled-back'
    | 'quarantined'
    | 'probation-ok'
    | 'probation-cleared'
  verdict?: string
  pr?: string
  costUsd: number
  turns: number
  minutes: number
  trace: string
  note?: string
  /** The harness version the run used, so a regression can be traced to its release. */
  harness?: string
}

function record(rec: RunRecord) {
  const file = path.join(ROOT, config.runsLog)
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(withHarnessVersion(rec))}\n`)
}

export function withHarnessVersion<T extends object>(
  rec: T & { harness?: string },
  version: string = packageVersion(),
): T & { harness: string } {
  return { ...rec, harness: rec.harness ?? version }
}

function readRunRecords(): RunRecord[] {
  const file = path.join(ROOT, config.runsLog)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunRecord)
}

function report() {
  const rows = readRunRecords()
  if (rows.length === 0) {
    console.log('no runs recorded yet')
    return
  }
  console.log('when              feature attempt outcome  verdict  turns  cost   min  harness  pr')
  for (const r of rows) {
    console.log(
      `${r.ts.slice(0, 16).replace('T', ' ')} ${r.feature}   ${String(r.attempt).padEnd(7)} ${r.outcome.padEnd(8)} ${(r.verdict ?? '-').padEnd(8)} ${String(r.turns).padStart(5)}  $${r.costUsd.toFixed(2).padStart(5)} ${String(r.minutes).padStart(4)}  ${(r.harness ?? '?').padEnd(7)}  ${r.pr ?? ''}`,
    )
  }
  const total = rows.reduce((s, r) => s + r.costUsd, 0)
  console.log(`\n${rows.length} run(s) · total $${total.toFixed(2)}`)
}

// ---------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------

const promptFile = (name: string) => readFileSync(path.join(PACKAGE_ROOT, 'prompts', name), 'utf8')

function projectNotes(p: Project): string {
  const notesFile = p.config.prompts.generatorNotes
  const notes = notesFile ? readFileSync(p.resolve(notesFile), 'utf8').trim() : ''
  return notes ? `\nProject notes (\`${notesFile}\`):\n\n${notes}\n` : ''
}

/** Arguments of a working session (generator or CI fixer): streamed, plugin loaded, generator caps. */
function sessionArgs(prompt: string, plugin: string): string[] {
  return [
    '-p',
    prompt,
    '--plugin-dir',
    plugin,
    '--permission-mode',
    config.generator.permissionMode,
    '--permission-prompts',
    'none',
    '--max-turns',
    String(config.caps.maxTurns),
    '--max-budget-usd',
    String(config.caps.maxBudgetUsd),
    '--model',
    config.generator.model,
    ...(config.generator.effort ? ['--effort', config.generator.effort] : []),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    '--allowedTools',
    ...config.allowedTools,
  ]
}

/** The generator prompt of `p` with the per-attempt placeholders left in (also `harness selftest`). */
export function generatorTemplate(p: Project = project): string {
  return render(promptFile('generator.md'), {
    PROJECT_NAME: p.config.project.name,
    PROJECT_NOTES: projectNotes(p),
    FEATURE_ID: '{{FEATURE_ID}}',
    FEATURE_TITLE: '{{FEATURE_TITLE}}',
    ATTEMPT: '{{ATTEMPT}}',
    MAX_ATTEMPTS: '{{MAX_ATTEMPTS}}',
    CONTEXT: '{{CONTEXT}}',
  })
}

// ---------------------------------------------------------------------------------------
// One feature
// ---------------------------------------------------------------------------------------

type IterationOutcome = 'done' | 'blocked' | 'failed' | 'aborted'

async function runFeature(
  feature: Feature,
  opts: Options,
  intake?: IntakeItem,
): Promise<IterationOutcome> {
  const id = feature.id
  const started = Date.now()
  if (!opts.dryRun) {
    logFile = path.join(ROOT, config.traceDir, `${id}-${stamp()}.log`)
    mkdirSync(path.dirname(logFile), { recursive: true })
    log(`${id} — ${feature.title}; readable log: ${path.relative(ROOT, logFile)}`)
  }
  const dir = ensureWorktree(id, opts.dryRun)
  if (intake) addIntakeFeature(dir, intake, opts.dryRun)
  const plugin = pluginDir(opts.dryRun ? ROOT : dir)
  const template = generatorTemplate()
  const maxAttempts = feature.max_attempts ?? config.caps.maxAttempts
  let context = ''
  let attempt = feature.attempts

  while (attempt < maxAttempts) {
    attempt += 1
    const prompt = render(template, {
      FEATURE_ID: id,
      FEATURE_TITLE: feature.title,
      ATTEMPT: String(attempt),
      MAX_ATTEMPTS: String(maxAttempts),
      CONTEXT: context ? `\nContext from the previous attempt:\n${context}\n` : '',
    })
    const generatorArgs = sessionArgs(prompt, plugin)
    const env = { HARNESS_LOOP: '1', HARNESS_STOP_GUARD: '1', HARNESS_FEATURE: id }
    const traceFile = path.join(ROOT, config.traceDir, `${id}-${stamp()}.generator.jsonl`)

    log(
      `=== ${id} attempt ${attempt}/${maxAttempts}: generator session (${config.generator.model}, ≤${config.caps.maxTurns} turns, ≤$${config.caps.maxBudgetUsd}, ≤${config.caps.wallClockMin} min)`,
    )
    if (opts.dryRun) {
      log(`would run in ${dir} with env ${JSON.stringify(env)}:`)
      console.log(
        `  claude ${generatorArgs.map((a) => (a === prompt ? `"<generator prompt, ${prompt.length} chars>"` : a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`,
      )
      console.log(`  trace → ${traceFile}`)
      log(
        `would then: post-check (feature status, clean-state --require-terminal, commits ahead of ${defaultBranch()})`,
      )
      console.log(
        `  claude -p "<evaluator prompt>" --plugin-dir ${plugin} --append-system-prompt "<plugin agents/evaluator.md body>" --tools ${evaluatorAgent(plugin).tools} --permission-mode ${config.generator.permissionMode} --permission-prompts none --max-turns ${config.evaluator.maxTurns} --max-budget-usd ${config.evaluator.maxBudgetUsd} --model ${config.evaluator.model}${config.evaluator.effort ? ` --effort ${config.evaluator.effort}` : ''} --output-format json --json-schema <prompts/evaluator-schema.json>`,
      )
      log(
        `would then: merge gate — a branch that changes reviewPaths ${config.review.mode === 'human' ? 'waits for a human' : 'gets a safety review session (hard stops wait for a human)'}`,
      )
      log(
        `would then: git push -u ${remote()} ${branchFor(id)} && gh pr create --base ${defaultBranch()} --head ${branchFor(id)} …; merge policy ${opts.autoMerge ? 'auto' : config.merge}`,
      )
      log(
        `with auto-merge, on a failed CI check: up to ${config.caps.maxCiFixAttempts} CI fixer session(s) in ${dir} (prompts/ci-fixer.md, same flags and env as the generator), evaluator, git push, wait again`,
      )
      return 'done'
    }

    const gen = await runClaude({
      cwd: dir,
      args: generatorArgs,
      env,
      traceFile,
      wallClockMs: config.caps.wallClockMin * 60_000,
      stream: true,
    })
    log(`generator finished: ${describeResult(gen)}`)
    if (gen.pluginMissing)
      throw new Error(
        `the ${PLUGIN_NAME} plugin did not load from ${plugin}; run pnpm install in ${dir} and pnpm harness:doctor`,
      )
    if (aborting) {
      record({
        ts: new Date().toISOString(),
        feature: id,
        attempt,
        outcome: 'aborted',
        costUsd: Number(gen.result?.total_cost_usd ?? 0),
        turns: Number(gen.result?.num_turns ?? 0),
        minutes: Math.round((Date.now() - started) / 60000),
        trace: traceFile,
      })
      return 'aborted'
    }

    const check = postCheck(dir, id)
    const cost = Number(gen.result?.total_cost_usd ?? 0)
    const turns = Number(gen.result?.num_turns ?? 0)
    const minutes = () => Math.round((Date.now() - started) / 60000)

    if (check.status === 'blocked') {
      log(`${id} was blocked by the session: ${check.feature?.notes.slice(-300) ?? ''}`)
      pushBranch(id, dir)
      record({
        ts: new Date().toISOString(),
        feature: id,
        attempt,
        outcome: 'blocked',
        costUsd: cost,
        turns,
        minutes: minutes(),
        trace: traceFile,
        note: check.feature?.notes.slice(-300),
      })
      notify(`${id} blocked — needs a human (branch ${branchFor(id)} pushed)`)
      return 'blocked'
    }

    if (!check.ok) {
      const summary = check.problems.join('; ')
      log(`post-check failed (${check.problems.length} problem(s)):`)
      for (const problem of check.problems) log(`  ✗ ${problem}`)
      context = `The previous session ended in a bad state: ${summary}. The session result was: ${describeResult(gen)}. Continue from the current branch state (read git status, git log and ${config.project.progress} first) and finish the loop properly.`
      recordAttempt(dir, id, `post-check failed: ${summary}`)
      record({
        ts: new Date().toISOString(),
        feature: id,
        attempt,
        outcome: 'failed',
        costUsd: cost,
        turns,
        minutes: minutes(),
        trace: traceFile,
        note: summary,
      })
      continue
    }

    log(
      `post-check ok: ${id} is ${check.status}, clean-state check passed, ${check.ahead} commit(s) ahead of ${defaultBranch()}`,
    )

    const { verdict, cost: evalCost } = await runEvaluator(id, feature, dir, plugin)

    if (!verdict || verdict.verdict === 'Revise') {
      const findings = verdict
        ? verdictMarkdown(verdict)
        : 'The evaluator produced no verdict; treat the work as unreviewed and re-verify everything.'
      context = `The evaluator asked for revisions:\n${findings}\nAddress every finding, re-run /harness:verify-feature ${id}, then clock out again (AGENTS.md → Clock-out).`
      recordAttempt(dir, id, `evaluator: ${verdict?.verdict ?? 'no verdict'}`)
      record({
        ts: new Date().toISOString(),
        feature: id,
        attempt,
        outcome: 'failed',
        verdict: verdict?.verdict ?? 'none',
        costUsd: cost + evalCost,
        turns,
        minutes: minutes(),
        trace: traceFile,
        note: verdict?.required_follow_up.join('; '),
      })
      continue
    }
    if (verdict.verdict === 'Block') {
      const reason =
        `evaluator Block: ${verdict.required_follow_up.join('; ') || verdict.findings.map((f) => f.note).join('; ')}`.slice(
          0,
          500,
        )
      sh('pnpm', ['--silent', 'harness:feature', 'block', id, '--reason', reason], {
        cwd: dir,
        quiet: true,
      })
      commitState(dir, `chore(harness): block ${id} after evaluator verdict`)
      pushBranch(id, dir)
      record({
        ts: new Date().toISOString(),
        feature: id,
        attempt,
        outcome: 'blocked',
        verdict: 'Block',
        costUsd: cost + evalCost,
        turns,
        minutes: minutes(),
        trace: traceFile,
        note: reason,
      })
      notify(`${id} blocked by the evaluator — branch pushed for inspection`)
      return 'blocked'
    }

    // Accept → the merge gate, then publish.
    const gate = await reviewGate(id, feature, dir, intake?.safety)
    const review = gate.hold
    const { url: pr } = publish(
      id,
      dir,
      feature,
      check.feature,
      verdict,
      {
        cost: cost + evalCost,
        turns,
        trace: traceFile,
      },
      opts,
      intake,
      gate,
    )
    record({
      ts: new Date().toISOString(),
      feature: id,
      attempt,
      outcome: pr ? 'pr' : 'pushed',
      verdict: 'Accept',
      pr,
      costUsd: cost + evalCost + gate.cost,
      turns,
      minutes: minutes(),
      trace: traceFile,
      note: review.length > 0 ? `waits for a human: ${review.join('; ')}` : undefined,
    })
    if (pr && review.length > 0) {
      // Not merged, so dependents stay unready; independent features go on.
      notify(`${id} PR needs a human review before it merges (${review.join('; ')}): ${pr}`)
      return 'done'
    }
    if (pr && (config.merge !== 'none' || opts.autoMerge) && opts.wait) {
      const end = await shepherdPr({
        pr,
        id,
        dir,
        feature,
        plugin,
        auto: opts.autoMerge || config.merge === 'auto',
        attempt,
        started,
        safety: intake?.safety,
      })
      if (end !== 'merged') return end
      removeWorktree(id)
      must(
        'git',
        ['pull', '--ff-only', remote(), defaultBranch()],
        `git pull ${defaultBranch()} after merge`,
      )
      record({
        ts: new Date().toISOString(),
        feature: id,
        attempt,
        outcome: 'merged',
        verdict: 'Accept',
        pr,
        costUsd: 0,
        turns: 0,
        minutes: minutes(),
        trace: traceFile,
      })
    }
    return 'done'
  }

  // Attempts exhausted: `harness feature attempt` already auto-blocked the feature on the branch.
  pushBranch(id, dir)
  notify(`${id} exhausted ${maxAttempts} attempts — blocked, branch pushed`)
  return 'blocked'
}

/**
 * A retro issue's feature is written on its own branch, not on the default branch (protected, and
 * the driver never pushes it); the PR that implements it also adds it.
 */
function addIntakeFeature(dir: string, intake: IntakeItem, dryRun: boolean) {
  const id = intake.feature.id
  if (dryRun) {
    log(`would add ${id} to ${config.project.featureList} on ${branchFor(id)} from ${intake.url}`)
    return
  }
  const worktree = loadProject(dir)
  const file = worktree.resolve(worktree.config.project.featureList)
  const list = readFeatureList(file, worktree.config.features)
  if (list.features.some((f) => f.id === id)) return // reused worktree
  writeFeatureList(
    { ...list, last_updated: today(), features: [...list.features, intake.feature] },
    { file, features: worktree.config.features, cwd: dir },
  )
  commitState(dir, `chore(harness): add ${id} from retro issue #${intake.issue}`)
  log(`${id} added to ${config.project.featureList} from ${intake.url}`)
}

function recordAttempt(dir: string, id: string, reason: string) {
  sh('pnpm', ['--silent', 'harness:feature', 'attempt', id, '--reason', reason], {
    cwd: dir,
    quiet: true,
  })
  commitState(dir, `chore(harness): record failed attempt for ${id}`)
}

function commitState(dir: string, subject: string) {
  sh('git', ['add', config.project.featureList], { cwd: dir, quiet: true })
  const r = sh(
    'git',
    ['commit', '-q', '-m', `${subject}\n\nWritten by the loop driver (@eemelinen/harness).`],
    { cwd: dir, quiet: true },
  )
  if (r.code !== 0 && !/nothing to commit/.test(r.out + r.err))
    log(`state commit failed: ${r.err || r.out}`)
}

function pushBranch(id: string, dir: string): boolean {
  const r = sh('git', ['push', '-u', remote(), branchFor(id)], { cwd: dir, quiet: true })
  if (r.code !== 0) log(`git push failed: ${r.err}`)
  return r.code === 0
}

function publish(
  id: string,
  dir: string,
  feature: Feature,
  finished: Feature | undefined,
  verdict: Verdict,
  stats: { cost: number; turns: number; trace: string },
  opts: Options,
  intake: IntakeItem | undefined,
  gate: Gate,
): { url?: string } {
  pushBranch(id, dir)
  const review = gate.hold
  if (!ghAvailable()) {
    log(`gh is not available; branch ${branchFor(id)} pushed — open the PR by hand`)
    return {}
  }
  const body = [
    ...(intake ? [`Closes #${intake.issue} (harness retro).`, ''] : []),
    ...(review.length > 0
      ? ['> **Waits for a human review** — not auto-merged:', ...review.map((r) => `> - ${r}`), '']
      : []),
    ...(gate.notes.length > 0 ? [...gate.notes, ''] : []),
    `## ${id} — ${feature.title}`,
    '',
    feature.user_visible_behavior,
    '',
    feature.ticket ? `Ticket: ${feature.ticket} · spec: \`${feature.spec ?? ''}\`` : '',
    '',
    '### Evidence',
    ...(finished?.evidence ?? []).map((e) => `- ${e}`),
    '',
    verdictMarkdown(verdict),
    '',
    `Generator: ${stats.turns} turns, $${stats.cost.toFixed(2)} · trace \`${path.relative(ROOT, stats.trace)}\``,
  ].join('\n')
  const bodyFile = path.join(ROOT, config.traceDir, `${id}-pr-body.md`)
  writeFileSync(bodyFile, body)
  const r = sh(
    'gh',
    [
      'pr',
      'create',
      '--base',
      defaultBranch(),
      '--head',
      branchFor(id),
      '--title',
      `feat(${id}): ${feature.title}`,
      '--body-file',
      bodyFile,
    ],
    { cwd: dir, quiet: true },
  )
  if (r.code !== 0) {
    log(`gh pr create failed: ${r.err}`)
    return {}
  }
  const url = r.out.split('\n').find((l) => l.startsWith('https://')) ?? r.out
  log(`PR opened: ${url}`)
  if (review.length > 0) {
    log(`not arming auto-merge, the PR waits for a human: ${review.join('; ')}`)
  } else if (opts.autoMerge || config.merge === 'auto') {
    const m = sh('gh', ['pr', 'merge', url, '--auto', '--squash', '--delete-branch'], {
      cwd: dir,
      quiet: true,
    })
    if (m.code !== 0) log(`gh pr merge --auto failed: ${m.err}`)
  }
  return { url }
}

// ---------------------------------------------------------------------------------------
// Merge gate (src/review.ts)
// ---------------------------------------------------------------------------------------

interface Gate {
  /** Why the PR waits for a human; empty when it may auto-merge. */
  hold: string[]
  /** PR body lines for a passed safety review. */
  notes: string[]
  cost: number
}

function changedFiles(dir: string): string[] {
  return sh('git', ['diff', '--name-only', `${defaultBranch()}...HEAD`], { cwd: dir, quiet: true })
    .out.split('\n')
    .filter(Boolean)
}

/** The JSON files a hard stop compares, at `ref`; `null` when a file does not parse. */
function snapshot(dir: string, ref: string): Snapshot {
  const read = (file: string): unknown => {
    const r = sh('git', ['show', `${ref}:${file}`], { cwd: dir, quiet: true })
    if (r.code !== 0) return undefined
    try {
      return JSON.parse(r.out) as unknown
    } catch {
      return null
    }
  }
  return {
    config: read(CONFIG_FILE),
    settings: read('.claude/settings.json'),
    settingsLocal: read('.claude/settings.local.json'),
  }
}

/**
 * May this branch auto-merge? Changes outside `reviewPaths` (from a non-safety issue) may. Others
 * wait with `review.mode: human`; with `evaluate` a hard stop holds them, else the safety review
 * decides. The driver's own config applies, not the branch's, so a PR cannot loosen its own gate.
 */
async function reviewGate(
  id: string,
  feature: Feature,
  dir: string,
  safety?: boolean,
): Promise<Gate> {
  const files = changedFiles(dir)
  const reasons = reviewReasons(files, config.reviewPaths, safety)
  if (reasons.length === 0) return { hold: [], notes: [], cost: 0 }
  if (config.review.mode === 'human') return { hold: reasons, notes: [], cost: 0 }
  const stops = hardStops(snapshot(dir, defaultBranch()), snapshot(dir, 'HEAD'))
  if (stops.length > 0) {
    log(`merge gate: never auto-merged: ${stops.join('; ')}`)
    return {
      hold: [...reasons, ...stops.map((s) => `never auto-merged: ${s}`)],
      notes: [],
      cost: 0,
    }
  }
  const { verdict, cost } = await runSafetyReview(id, feature, dir, reasons, files)
  if (verdict?.verdict === 'safe')
    return {
      hold: [],
      notes: [
        `### Safety review: safe`,
        '',
        `Reviewed because: ${reasons.join('; ')}.`,
        ...verdict.reasons.map((r) => `- ${r}`),
      ],
      cost,
    }
  const why = verdict
    ? verdict.reasons.map((r) => `safety review: ${r}`)
    : ['safety review gave no verdict']
  return { hold: [...reasons, ...why], notes: [], cost }
}

const MAX_REVIEW_DIFF = 60_000

async function runSafetyReview(
  id: string,
  feature: Feature,
  dir: string,
  reasons: string[],
  files: string[],
): Promise<{ verdict?: SafetyVerdict; cost: number }> {
  const base = defaultBranch()
  const model = config.review.model ?? config.evaluator.model
  const effort = config.review.effort ?? config.evaluator.effort
  log(`=== ${id}: safety review (${model}): ${reasons.join('; ')}`)
  // The files that triggered the review; a safety-flagged issue that touched none gets the full diff.
  const reviewed = files.filter((f) => reviewReasons([f], config.reviewPaths).length > 0)
  let diff = sh('git', ['diff', `${base}...HEAD`, '--', ...reviewed], { cwd: dir, quiet: true }).out
  if (diff.length > MAX_REVIEW_DIFF)
    diff = `${diff.slice(0, MAX_REVIEW_DIFF)}\n… (truncated; read the files for the rest)`
  const prompt = render(promptFile('safety-review.md'), {
    PROJECT_NAME: config.project.name,
    FEATURE_ID: id,
    FEATURE_TITLE: feature.title,
    REASONS: reasons.map((r) => `- ${r}`).join('\n'),
    BASE: base,
    STAT: sh('git', ['diff', '--stat', `${base}...HEAD`], { cwd: dir, quiet: true }).out,
    DIFF: diff,
  })
  const res = await runClaude({
    cwd: dir,
    args: [
      '-p',
      prompt,
      '--tools',
      'Read,Glob,Grep',
      '--permission-mode',
      config.generator.permissionMode,
      '--permission-prompts',
      'none',
      '--max-turns',
      String(config.review.maxTurns),
      '--max-budget-usd',
      String(config.review.maxBudgetUsd),
      '--model',
      model,
      ...(effort ? ['--effort', effort] : []),
      '--output-format',
      'json',
      '--json-schema',
      promptFile('safety-review-schema.json'),
    ],
    env: { HARNESS_LOOP: '1' },
    traceFile: path.join(ROOT, config.traceDir, `${id}-${stamp()}.safety.json`),
    wallClockMs: config.review.wallClockMin * 60_000,
    stream: false,
  })
  const verdict = parseSafetyVerdict(res.result)
  log(`safety review finished: ${describeResult(res)} → ${verdict?.verdict ?? 'no verdict'}`)
  for (const r of verdict?.reasons ?? []) log(`  ${r.replace(/\s+/g, ' ').slice(0, 200)}`)
  return { verdict, cost: Number(res.result?.total_cost_usd ?? 0) }
}

type WaitResult =
  { state: 'merged' } | { state: 'ci_failed'; failed: CiCheck[] } | { state: 'stalled' }

/** With auto-merge, how long CI may report nothing new before the driver stops waiting. */
const CI_STALL_MIN = 20

/**
 * Polls until the PR merges. With auto-merge, returns early when CI failed (auto-merge never
 * fires on a red check) or reported nothing for CI_STALL_MIN minutes. Check results in `handled`
 * were already acted on and are ignored; a push or a rerun gives the new jobs new links.
 */
async function waitForMerge(pr: string, auto: boolean, handled: Set<string>): Promise<WaitResult> {
  log(`waiting for ${auto ? 'CI and auto-merge' : 'a human merge'}: ${pr}`)
  const reported = new Set<string>()
  const waitStarted = Date.now()
  let lastNews = Date.now()
  for (let poll = 0; ; poll++) {
    const checks = parseChecks(
      sh('gh', ['pr', 'checks', pr, '--json', 'name,bucket,link,workflow'], { quiet: true }).out,
    ).filter((c) => !handled.has(c.link))
    const pending = checks.filter((c) => c.bucket === 'pending').length
    const failed = checks.filter(isFailed)
    if (checks.length > 0) lastNews = Date.now()
    for (const c of checks) {
      if (c.bucket !== 'pending' && !reported.has(c.link)) {
        reported.add(c.link)
        log(`${c.bucket === 'pass' ? '✓' : '✗'} CI ${c.name}: ${c.bucket}`)
      }
    }
    const r = sh('gh', ['pr', 'view', pr, '--json', 'state,mergedAt'], { quiet: true })
    if (r.code === 0) {
      const info = JSON.parse(r.out) as { state: string }
      if (info.state === 'MERGED') {
        log(`PR merged after ${Math.round((Date.now() - waitStarted) / 60000)} min: ${pr}`)
        return { state: 'merged' }
      }
      if (info.state === 'CLOSED') throw new Error(`PR ${pr} was closed without merging`)
    }
    if (auto && pending === 0 && failed.length > 0) return { state: 'ci_failed', failed }
    if (auto && Date.now() - lastNews > CI_STALL_MIN * 60_000) return { state: 'stalled' }
    if (poll > 0 && poll % 5 === 0)
      log(
        `… still waiting for the merge (${Math.round((Date.now() - waitStarted) / 60000)} min, ${pending} check(s) pending)`,
      )
    if (aborting) throw new Error('aborted while waiting for merge')
    await sleep(60_000)
  }
}

// ---------------------------------------------------------------------------------------
// CI fixer
// ---------------------------------------------------------------------------------------

interface PrRun {
  pr: string
  id: string
  dir: string
  feature: Feature
  plugin: string
  auto: boolean
  /** The generator attempt that produced the PR (for the run log). */
  attempt: number
  started: number
  /** Built from a retro issue marked as a safety change. */
  safety?: boolean
}

/** Log excerpts of the failed jobs, one block per workflow run. */
function ciEvidence(failed: CiCheck[]): string {
  const ids = runIds(failed)
  if (ids.length === 0) return '(no GitHub Actions run behind these checks; open the links above)'
  return ids
    .map((runId) => {
      const r = sh('gh', ['run', 'view', runId, '--log-failed'], { quiet: true })
      const text = r.code === 0 ? logExcerpt(r.out) : `gh run view failed: ${r.err || r.out}`
      return ids.length > 1 ? `# run ${runId}\n${text}` : text
    })
    .join('\n\n')
}

function rerunFailed(failed: CiCheck[]): boolean {
  let ok = true
  for (const runId of runIds(failed)) {
    const r = sh('gh', ['run', 'rerun', runId, '--failed'], { quiet: true })
    if (r.code !== 0) {
      log(`gh run rerun ${runId} --failed failed: ${r.err || r.out}`)
      ok = false
    }
  }
  return ok
}

/**
 * Waits for the PR to merge. With auto-merge, a failed CI check no longer stops the loop: the
 * driver passes the failed-job logs to a fixer session in the feature's worktree, re-checks
 * and re-evaluates its commit, pushes, and waits again, up to `caps.maxCiFixAttempts` sessions.
 * Cancelled jobs, and failures the fixer calls flaky without changing anything, are re-run once.
 * When nothing works the driver gives up on this PR only (giveUp()); the loop continues.
 */
async function shepherdPr(run: PrRun): Promise<'merged' | 'blocked' | 'aborted'> {
  const { pr, id, dir, feature, plugin, auto } = run
  notify(`PR ready: ${pr}${auto ? ' (auto-merge armed)' : ' — merge it to let the loop continue'}`)
  const max = config.caps.maxCiFixAttempts
  const handled = new Set<string>()
  const minutes = () => Math.round((Date.now() - run.started) / 60000)
  const base = { feature: id, attempt: run.attempt, pr, minutes: 0, costUsd: 0, turns: 0 }
  let failed: CiCheck[] = []
  let evidence = ''
  let context = ''
  let ciAttempt = 0
  let rerunDone = false
  let pushedHead = must('git', ['rev-parse', 'HEAD'], 'git rev-parse', dir)

  for (;;) {
    if (failed.length === 0) {
      const waited = await waitForMerge(pr, auto, handled)
      if (waited.state === 'merged') return 'merged'
      if (waited.state === 'stalled')
        return giveUp(run, `CI reported nothing new for ${CI_STALL_MIN} min`, evidence)
      failed = waited.failed
      for (const c of failed) handled.add(c.link)
      const names = failed.map((c) => c.name).join(', ')
      log(`CI failed on ${pr}: ${names}`)
      evidence = ciEvidence(failed)
      if (!rerunDone && failed.every((c) => c.bucket === 'cancel')) {
        rerunDone = true
        log('only cancelled jobs: re-running them once')
        record({
          ...base,
          ts: new Date().toISOString(),
          outcome: 'ci-rerun',
          minutes: minutes(),
          trace: '',
          note: `cancelled: ${names}`,
        })
        if (!rerunFailed(failed)) return giveUp(run, 'gh run rerun failed', evidence)
        failed = []
        continue
      }
    }
    if (aborting) return 'aborted'
    const names = failed.map((c) => c.name).join(', ')
    if (ciAttempt >= max)
      return giveUp(run, `CI still failing after ${max} fix attempt(s): ${names}`, evidence)
    ciAttempt += 1

    const prompt = render(promptFile('ci-fixer.md'), {
      PROJECT_NAME: config.project.name,
      PROJECT_NOTES: projectNotes(project),
      FEATURE_ID: id,
      FEATURE_TITLE: feature.title,
      PR: pr,
      ATTEMPT: String(ciAttempt),
      MAX_ATTEMPTS: String(max),
      FAILED_CHECKS: describeChecks(failed),
      LOG_EXCERPT: evidence,
      BASE: `${remote()}/${defaultBranch()}`,
      CONTEXT: context ? `\nContext from the previous fix attempt:\n${context}\n` : '',
    })
    const before = must('git', ['rev-parse', 'HEAD'], 'git rev-parse', dir)
    const traceFile = path.join(ROOT, config.traceDir, `${id}-${stamp()}.ci-fix.jsonl`)
    log(
      `=== ${id} CI fix ${ciAttempt}/${max}: fixer session for ${names} (${config.generator.model})`,
    )
    const fix = await runClaude({
      cwd: dir,
      args: sessionArgs(prompt, plugin),
      env: { HARNESS_LOOP: '1', HARNESS_STOP_GUARD: '1', HARNESS_FEATURE: id },
      traceFile,
      wallClockMs: config.caps.wallClockMin * 60_000,
      stream: true,
    })
    log(`fixer finished: ${describeResult(fix)}`)
    if (fix.pluginMissing)
      throw new Error(
        `the ${PLUGIN_NAME} plugin did not load from ${plugin}; run pnpm install in ${dir}`,
      )
    const cost = Number(fix.result?.total_cost_usd ?? 0)
    const turns = Number(fix.result?.num_turns ?? 0)
    const fixRecord = { ...base, costUsd: cost, turns, trace: traceFile }
    if (aborting) {
      record({ ...fixRecord, ts: new Date().toISOString(), outcome: 'aborted', minutes: minutes() })
      return 'aborted'
    }

    const check = postCheck(dir, id)
    const newCommits = Number(
      sh('git', ['rev-list', '--count', `${before}..HEAD`], { cwd: dir, quiet: true }).out || 0,
    )
    const verdict = parseFixVerdict(fix.result)
    const decision = decideCiFix({
      status: check.status,
      newCommits,
      postCheckOk: check.ok,
      verdict,
      rerunDone,
    })
    log(
      `fixer says ${verdict ? `${verdict.classification}: ${verdict.reason}` : 'nothing (no CI-FIX-VERDICT line)'}; ${newCommits} new commit(s), feature ${check.status} → ${decision}`,
    )
    const note = (text: string) => `ci fix ${ciAttempt}/${max}: ${text}`.slice(0, 500)

    if (decision === 'give-up') {
      const reason =
        check.status === 'blocked'
          ? `the fixer blocked ${id}: ${check.feature?.notes.slice(-300) ?? ''}`
          : `the fixer judged the failure out of scope: ${verdict?.reason ?? ''}`
      return giveUp(run, note(reason), evidence, {
        outcome: 'blocked',
        costUsd: cost,
        turns,
        trace: traceFile,
      })
    }
    if (decision === 'rerun') {
      record({
        ...fixRecord,
        ts: new Date().toISOString(),
        outcome: 'ci-rerun',
        minutes: minutes(),
        note: note(verdict?.reason ?? 'flaky'),
      })
      rerunDone = true
      log(`re-running the failed jobs once (flaky: ${verdict?.reason ?? ''})`)
      if (!rerunFailed(failed)) return giveUp(run, 'gh run rerun failed', evidence)
      failed = []
      context = ''
      continue
    }
    if (decision === 'retry') {
      const problems = check.ok ? [] : check.problems
      const why =
        newCommits > 0
          ? `the session ended in a bad state: ${problems.join('; ')}`
          : `the session committed no fix (verdict: ${verdict?.classification ?? 'none'}${rerunDone && verdict?.classification === 'flaky' ? ', and the one rerun was already spent' : ''})`
      for (const problem of problems) log(`  ✗ ${problem}`)
      record({
        ...fixRecord,
        ts: new Date().toISOString(),
        outcome: 'failed',
        minutes: minutes(),
        note: note(why),
      })
      context = `The previous fix session failed: ${why}. The session result was: ${describeResult(fix)}. Continue from the current branch state (git status, git log, PROGRESS.md).`
      continue
    }

    // A verified fix commit: review it like the feature itself before it can merge unattended.
    const ciContext = `\nThis branch was accepted before, then CI failed on ${pr} (${names}). The commits after ${pushedHead.slice(0, 12)} fix that failure (\`git diff ${pushedHead}..HEAD\`). Check that they fix the root cause inside the feature's scope and that no test, assertion, coverage threshold or CI setting was weakened.\n`
    const ev = await runEvaluator(id, feature, dir, plugin, ciContext)
    const total = cost + ev.cost
    if (ev.verdict?.verdict === 'Accept') {
      // Auto-merge is armed: a fix that now needs review must not reach the PR unreviewed.
      const gate = await reviewGate(id, feature, dir, run.safety)
      if (gate.hold.length > 0)
        return giveUp(run, `the CI fix needs a human review: ${gate.hold.join('; ')}`, evidence, {
          costUsd: total + gate.cost,
          turns,
          trace: traceFile,
          verdict: 'Accept',
        })
      if (!pushBranch(id, dir)) return giveUp(run, 'git push of the CI fix failed', evidence)
      pushedHead = must('git', ['rev-parse', 'HEAD'], 'git rev-parse', dir)
      record({
        ...fixRecord,
        ts: new Date().toISOString(),
        outcome: 'ci-fix',
        verdict: 'Accept',
        costUsd: total,
        minutes: minutes(),
        note: note(verdict?.reason ?? ''),
      })
      log(`CI fix pushed (${newCommits} commit(s)); auto-merge is still armed`)
      failed = []
      context = ''
      continue
    }
    if (ev.verdict?.verdict === 'Block') {
      const reason =
        `evaluator Block on the CI fix: ${ev.verdict.required_follow_up.join('; ') || ev.verdict.findings.map((f) => f.note).join('; ')}`.slice(
          0,
          500,
        )
      sh('pnpm', ['--silent', 'harness:feature', 'block', id, '--reason', reason], {
        cwd: dir,
        quiet: true,
      })
      commitState(dir, `chore(harness): block ${id} after evaluator verdict on a CI fix`)
      return giveUp(run, note(reason), evidence, {
        outcome: 'blocked',
        verdict: 'Block',
        costUsd: total,
        turns,
        trace: traceFile,
      })
    }
    record({
      ...fixRecord,
      ts: new Date().toISOString(),
      outcome: 'failed',
      verdict: ev.verdict?.verdict ?? 'none',
      costUsd: total,
      minutes: minutes(),
      note: note(ev.verdict?.required_follow_up.join('; ') ?? 'no verdict'),
    })
    context = ev.verdict
      ? `The evaluator asked for revisions of your fix:\n${verdictMarkdown(ev.verdict)}\nAddress every finding, re-verify, and commit again.`
      : 'The evaluator produced no verdict on your fix; re-verify everything before committing again.'
  }
}

/**
 * Stops working on this PR without stopping the loop: auto-merge off (so nothing unreviewed
 * merges later), the branch pushed for inspection, the reason on the PR, a notification. The
 * worktree stays, like for any unmerged PR; the loop moves on to features that do not depend on it.
 */
function giveUp(
  run: PrRun,
  reason: string,
  evidence: string,
  session: Partial<Pick<RunRecord, 'costUsd' | 'turns' | 'trace' | 'verdict'>> & {
    outcome?: 'failed' | 'blocked'
  } = {},
): 'blocked' {
  const { pr, id, dir } = run
  log(`giving up on ${pr}: ${reason}`)
  const disabled = sh('gh', ['pr', 'merge', pr, '--disable-auto'], { cwd: dir, quiet: true })
  if (disabled.code === 0) pushBranch(id, dir)
  else log(`gh pr merge --disable-auto failed (${disabled.err}); not pushing unreviewed commits`)
  const bodyFile = path.join(ROOT, config.traceDir, `${id}-ci-give-up.md`)
  writeFileSync(
    bodyFile,
    [
      `The loop driver stopped trying to get CI green on this PR: ${reason}`,
      '',
      `Auto-merge is ${disabled.code === 0 ? 'disabled' : 'still armed (disabling failed)'}. Fix the branch (worktree \`${dir}\`), push, then merge or re-enable auto-merge. Fixer traces: \`${config.traceDir}/${id}-*.ci-fix.jsonl\`.`,
      ...(evidence
        ? [
            '',
            '<details><summary>Last failed-job log excerpt</summary>',
            '',
            '```',
            evidence,
            '```',
            '</details>',
          ]
        : []),
    ].join('\n'),
  )
  const comment = sh('gh', ['pr', 'comment', pr, '--body-file', bodyFile], {
    cwd: dir,
    quiet: true,
  })
  if (comment.code !== 0) log(`gh pr comment failed: ${comment.err}`)
  record({
    ts: new Date().toISOString(),
    feature: id,
    attempt: run.attempt,
    outcome: session.outcome ?? 'failed',
    verdict: session.verdict,
    pr,
    costUsd: session.costUsd ?? 0,
    turns: session.turns ?? 0,
    minutes: Math.round((Date.now() - run.started) / 60000),
    trace: session.trace ?? '',
    note: reason.slice(0, 500),
  })
  notify(
    `${id}: gave up on ${pr} — ${reason.slice(0, 200)}; the loop continues with independent features`,
  )
  return 'blocked'
}

// ---------------------------------------------------------------------------------------
// Harness update (src/update.ts)
// ---------------------------------------------------------------------------------------

/** What a loop run keeps across a restart onto a new harness version (`HARNESS_LOOP_CARRY`). */
export interface Carry {
  attempted: string[]
  intakeIssues: number[]
  retros: number
  consecutiveFailures: number
  /** Releases this run already updated to, tried to, or reported; each is handled once. */
  updates: string[]
  /** Set when an update merged: the first feature on `version` decides whether it stays. */
  probation?: { version: string; from: string }
  /** Set after a probation rollback: `feature` runs again on `from` to test `suspect`. */
  retry?: Retry
}

export interface Retry {
  feature: string
  suspect: string
  from: string
  evidence: string[]
  /** The retro issue the feature came from; its feature exists only on the set-aside branch. */
  intake?: IntakeItem
}

export const CARRY_ENV = 'HARNESS_LOOP_CARRY'

/**
 * What the first feature after an update says about the release: `passed` keeps it, `suspect`
 * rolls back and re-tests, `pending` (an aborted run) decides nothing.
 */
export function probationResult(
  outcome: IterationOutcome | 'error',
): 'passed' | 'suspect' | 'pending' {
  if (outcome === 'done') return 'passed'
  if (outcome === 'aborted') return 'pending'
  return 'suspect'
}

/** Outcomes that settle a probation; a restarted driver that wrote none of them did not finish one. */
const PROBATION_SETTLED = new Set([
  'probation-ok',
  'rolled-back',
  'quarantined',
  'probation-cleared',
])

/**
 * After a restarted driver exits: `rollback` when it ran a release on probation and exited with an
 * error before settling it (it crashed on the new version), else `exit` with its code.
 */
export function supervise(s: {
  code: number
  aborted: boolean
  probation?: { version: string; from: string }
  records: { outcome: string }[]
}): 'exit' | 'rollback' {
  if (!s.probation || s.aborted || s.code === 0) return 'exit'
  return s.records.some((r) => PROBATION_SETTLED.has(r.outcome)) ? 'exit' : 'rollback'
}

/** The feature to re-test after a probation rollback, if it is still there. */
export function retryFeature(retry: Retry | undefined, list: { features: Feature[] }) {
  if (!retry) return undefined
  return retry.intake?.feature ?? list.features.find((f) => f.id === retry.feature)
}

/** Where a probation run's branch is kept for inspection, out of the feature queue. */
export const asideBranch = (version: string, id: string) => `harness/probation-v${version}-${id}`

export function readCarry(raw: string | undefined): Carry {
  const empty: Carry = {
    attempted: [],
    intakeIssues: [],
    retros: 0,
    consecutiveFailures: 0,
    updates: [],
  }
  if (!raw) return empty
  try {
    return { ...empty, ...(JSON.parse(raw) as Partial<Carry>) }
  } catch {
    return empty
  }
}

function readJson(file: string): unknown {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
}

const pinSnapshot = (dir: string): PinSnapshot => ({
  packageJson: readJson(path.join(dir, 'package.json')),
  settings: readJson(path.join(dir, '.claude', 'settings.json')),
})

/** `harness/update-vX.Y.Z` moving forward, `harness/rollback-vX.Y.Z` moving back. */
export const pinBranch = (version: string, forward: boolean) =>
  `harness/${forward ? 'update' : 'rollback'}-v${version}`

/** Does the remote default branch already pin `version` (an update PR merged by a human)? */
function defaultBranchPins(version: string): boolean {
  if (sh('git', ['fetch', remote(), defaultBranch()], { quiet: true }).code !== 0) return false
  const r = sh('git', ['show', `${remote()}/${defaultBranch()}:package.json`], { quiet: true })
  if (r.code !== 0) return false
  const pkg = JSON.parse(r.out) as Record<string, Record<string, string> | undefined>
  return (pkg.devDependencies?.[PACKAGE] ?? pkg.dependencies?.[PACKAGE]) === pinSpec(version)
}

/** The default branch has the new pins: pull it and install, so a restart runs that version. */
function takeUpdate(installed: string, target: string, pr?: string): true {
  must('git', ['pull', '--ff-only', remote(), defaultBranch()], 'git pull after the harness update')
  const install = sh('pnpm', ['install', '--frozen-lockfile'], { quiet: true })
  if (install.code !== 0)
    throw new Error(`pnpm install after the harness update failed: ${install.err}`)
  record({
    ts: new Date().toISOString(),
    feature: 'harness',
    attempt: 1,
    outcome: compareVersions(target, installed) > 0 ? 'updated' : 'rolled-back',
    pr,
    costUsd: 0,
    turns: 0,
    minutes: 0,
    trace: '',
    note: `v${installed} → v${target}`,
  })
  return true
}

/**
 * The selftest checks that pass with the installed version (run in ROOT) and fail with the new
 * one (run in the update worktree). A version without `selftest` counts as all-pass.
 */
function selftestRegressions(dir: string): Check[] {
  const run = (cwd: string): Check[] | undefined => {
    const r = sh(process.execPath, [installedBin(cwd), 'selftest', '--json'], { cwd, quiet: true })
    try {
      return JSON.parse(r.out) as Check[]
    } catch {
      return undefined
    }
  }
  const before = run(ROOT) ?? []
  const after = run(dir)
  if (!after)
    return [
      { name: 'selftest runs', ok: false, detail: 'the new version printed no selftest JSON' },
    ]
  return regressions(before, after)
}

type PinResult = { state: 'merged' | 'waiting' | 'failed' | 'quarantined'; pr?: string }

/**
 * One PR that only moves the harness pins to `target`, from its own worktree, so a feature PR never
 * carries it. Moving forward, the new version's selftest must not regress against the installed
 * one, or the release is quarantined instead. Then doctor and `init.sh` with the L1 baseline run on
 * the new pins. A diff that changes only the pins skips the merge gate (src/update.ts →
 * notPinOnly) and auto-merges under the auto merge policy; the driver waits for it even with
 * --no-wait, because only a merged change can be pulled. Failures are notified, never thrown.
 */
async function pinPr(
  target: string,
  installed: string,
  opts: Options,
  why: string,
): Promise<PinResult> {
  const forward = compareVersions(target, installed) > 0
  const branch = pinBranch(target, forward)
  const dir = path.join(worktreeRoot(project), branch.replace('/', '-'))
  const auto = opts.autoMerge || config.merge === 'auto'
  const subject = forward
    ? `chore(harness): update to v${target}`
    : `chore(harness): roll back to v${target}`
  log(`=== harness ${forward ? 'update' : 'rollback'} v${installed} → v${target} (${why})`)
  try {
    sh('git', ['worktree', 'remove', '--force', dir], { quiet: true })
    sh('git', ['branch', '-D', branch], { quiet: true })
    mkdirSync(path.dirname(dir), { recursive: true })
    must('git', ['worktree', 'add', '-b', branch, dir, defaultBranch()], 'git worktree add')
    const before = pinSnapshot(dir)
    applyUpdate(dir, target, log)
    if (forward) {
      const regressed = selftestRegressions(dir)
      if (regressed.length > 0) {
        for (const c of regressed) log(`  ✗ selftest ${c.name}: ${c.detail}`)
        const filed = quarantine(project, {
          version: target,
          from: installed,
          cause: `harness selftest regresses: ${regressed.map((c) => c.name).join(', ')}`,
          evidence: regressed.map(
            (c) => `\`${c.name}\` passes on v${installed}, fails on v${target}: ${c.detail}`,
          ),
        })
        record({
          ts: new Date().toISOString(),
          feature: 'harness',
          attempt: 1,
          outcome: 'quarantined',
          pr: filed.url,
          costUsd: 0,
          turns: 0,
          minutes: 0,
          trace: '',
          note: `v${target}: selftest regressions (${filed.action})`,
          harness: installed,
        })
        notify(
          `harness v${target} quarantined: selftest regresses in ${config.project.name} (${filed.url}); the loop stays on v${installed}`,
        )
        return { state: 'quarantined', pr: filed.url }
      }
      log(`selftest of v${target}: no regression against v${installed}`)
    }
    log(`${config.project.init} with the L1 baseline on v${target}`)
    const init = sh('bash', [config.project.init], { cwd: dir, quiet: true })
    if (init.code !== 0)
      throw new Error(
        `${config.project.init} failed on v${target}:\n${`${init.out}\n${init.err}`.trim().slice(-2000)}`,
      )
    must('git', ['add', '-A'], 'git add', dir)
    const changed = must('git', ['diff', '--cached', '--name-only'], 'git diff', dir)
      .split('\n')
      .filter(Boolean)
    const hold = notPinOnly(changed, before, pinSnapshot(dir))
    must(
      'git',
      [
        'commit',
        '-m',
        subject,
        '-m',
        `Opened by the loop driver (update.auto) on v${installed}: ${why}.`,
      ],
      'git commit',
      dir,
    )
    must('git', ['push', '-u', remote(), branch], 'git push', dir)
    if (!ghAvailable()) {
      notify(`harness ${branch} pushed; open and merge its PR by hand`)
      return { state: 'waiting' }
    }
    const repo = rolloutRepo(config)
    const body = [
      `Moves the harness from v${installed} to v${target}: ${why}.`,
      '',
      forward
        ? `Release notes: https://github.com/${repo}/releases/tag/v${target} · changes: https://github.com/${repo}/compare/v${installed}...v${target}`
        : `Release notes of v${target}: https://github.com/${repo}/releases/tag/v${target}`,
      '',
      ...(hold.length > 0
        ? [
            '> **Waits for a human review** — more than the harness pin changed:',
            ...hold.map((r) => `> - ${r}`),
          ]
        : [
            `Changes only the harness pin; checked on v${target} with ${forward ? '`harness selftest` against v' + installed + ', ' : ''}\`harness doctor\` and \`${config.project.init}\` (L1 baseline). Opened by the loop driver (\`update.auto\`).`,
          ]),
    ].join('\n')
    const bodyFile = path.join(ROOT, config.traceDir, `${branch.replace('/', '-')}-pr-body.md`)
    mkdirSync(path.dirname(bodyFile), { recursive: true })
    writeFileSync(bodyFile, body)
    const created = sh(
      'gh',
      [
        'pr',
        'create',
        '--base',
        defaultBranch(),
        '--head',
        branch,
        '--title',
        subject,
        '--body-file',
        bodyFile,
      ],
      { cwd: dir, quiet: true },
    )
    if (created.code !== 0) throw new Error(`gh pr create failed: ${created.err}`)
    const pr = created.out.split('\n').find((l) => l.startsWith('https://')) ?? created.out
    log(`harness pin PR: ${pr}`)
    if (hold.length > 0 || !auto) {
      notify(
        `harness ${forward ? 'update' : 'rollback'} to v${target} waits for a merge${hold.length > 0 ? ` (${hold.join('; ')})` : ''}; the loop stays on v${installed}: ${pr}`,
      )
      return { state: 'waiting', pr }
    }
    const armed = sh('gh', ['pr', 'merge', pr, '--auto', '--squash', '--delete-branch'], {
      cwd: dir,
      quiet: true,
    })
    if (armed.code !== 0) throw new Error(`gh pr merge --auto failed: ${armed.err}`)
    const waited = await waitForMerge(pr, true, new Set())
    if (waited.state === 'merged') return { state: 'merged', pr }
    sh('gh', ['pr', 'merge', pr, '--disable-auto'], { quiet: true })
    notify(
      `harness ${forward ? 'update' : 'rollback'} to v${target}: CI ${waited.state === 'stalled' ? `reported nothing for ${CI_STALL_MIN} min` : 'failed'}; auto-merge disabled, the loop stays on v${installed}: ${pr}`,
    )
    return { state: 'failed', pr }
  } catch (error) {
    if (aborting) throw error
    notify(
      `harness ${forward ? 'update' : 'rollback'} to v${target} failed, the loop stays on v${installed}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { state: 'failed' }
  } finally {
    sh('git', ['worktree', 'remove', '--force', dir], { quiet: true })
    sh('git', ['branch', '-D', branch], { quiet: true })
  }
}

let ghWarned = false

/**
 * Before a feature starts, with `update.auto`: move the pins to the release pickTarget chooses
 * (src/update.ts): the newest one that is old enough, not breaking and not quarantined, or another
 * release when the installed one is quarantined. Returns true when the default branch now has the
 * new pins and the driver must restart. Each release is handled once per loop run.
 */
async function maybeUpdate(opts: Options, carry: Carry): Promise<boolean> {
  if (!config.update.auto || isHarnessRepo(ROOT)) return false
  if (!ghAvailable()) {
    if (!ghWarned)
      log('harness update skipped: gh is not logged in (releases and quarantines are read with gh)')
    ghWarned = true
    return false
  }
  const installed = packageVersion()
  const repo = rolloutRepo(config)
  let target: Target
  try {
    target = pickTarget({
      installed,
      releases: listReleases(repo, ROOT),
      quarantined: listQuarantined(repo, ROOT),
      now: Date.now(),
      minAgeHours: config.update.minAgeHours,
      allowBreaking: config.update.allowBreaking,
    })
  } catch (error) {
    log(`harness update check skipped: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  if (target.action === 'none') {
    if (target.reason) log(`harness update: ${target.reason}`)
    return false
  }
  const version = target.version
  if (carry.updates.includes(version)) return false
  if (target.action === 'notify') {
    carry.updates.push(version)
    notify(target.reason)
    return false
  }
  const forward = compareVersions(version, installed) > 0
  const probation = forward ? { version, from: installed } : undefined
  if (!opts.dryRun && defaultBranchPins(version)) {
    carry.updates.push(version)
    log(`${defaultBranch()} already pins harness v${version}; pulling it`)
    try {
      takeUpdate(installed, version)
      carry.probation = probation
      return true
    } catch (error) {
      notify(
        `harness update to v${version} failed, the loop stays on v${installed}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }
  const branch = pinBranch(version, forward)
  if (sh('git', ['ls-remote', '--heads', remote(), `refs/heads/${branch}`], { quiet: true }).out) {
    log(`harness update: ${branch} is still open`)
    return false
  }
  carry.updates.push(version)
  if (opts.dryRun) {
    log(`would move harness v${installed} → v${version} before the next feature (${target.why}):`)
    log(
      `  git worktree add -b ${branch} … ${defaultBranch()}; pnpm add ${PACKAGE}@${pinSpec(version)}, marketplace ref, harness doctor`,
    )
    if (forward)
      log(
        `  harness selftest of v${installed} and v${version}; a regression quarantines v${version}`,
      )
    log(
      `  ${config.project.init} with the L1 baseline; commit, push, PR; ${opts.autoMerge || config.merge === 'auto' ? 'auto-merge, wait, pull, pnpm install, restart' : 'then wait for a human merge'}`,
    )
    return false
  }
  const result = await pinPr(version, installed, opts, target.why)
  if (result.state !== 'merged') return false
  try {
    takeUpdate(installed, version, result.pr)
    carry.probation = probation
    return true
  } catch (error) {
    notify(
      `harness pins moved to v${version} but the pull or install failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
}

/** Runs the loop again on the harness now installed in ROOT and waits for it. */
function restart(carry: Carry): { code: number; signal: string | null; since: string } {
  const bin = installedBin(ROOT)
  const since = new Date().toISOString()
  log(`restarting the driver on harness ${path.relative(ROOT, bin)}`)
  const child = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, [CARRY_ENV]: JSON.stringify(carry) },
  })
  return { code: child.status ?? 1, signal: child.signal, since }
}

/**
 * Keeps a probation run's branch for inspection as asideBranch() and takes it out of the queue:
 * the feature branch is deleted on the remote and locally with its worktree, so its attempts and
 * any auto-block on it do not count against the feature.
 */
function setAside(id: string, version: string): string {
  const branch = branchFor(id)
  const aside = asideBranch(version, id)
  const local = sh('git', ['rev-parse', '--verify', '--quiet', branch], { quiet: true }).code === 0
  if (local) {
    const pushed = sh(
      'git',
      ['push', '--force', remote(), `refs/heads/${branch}:refs/heads/${aside}`],
      {
        quiet: true,
      },
    )
    log(
      pushed.code === 0
        ? `kept ${id}'s probation run as ${aside}`
        : `could not push ${aside}: ${pushed.err}`,
    )
  }
  sh('git', ['push', remote(), '--delete', branch], { quiet: true })
  removeWorktree(id)
  return aside
}

/** The run records of `id` on `version`, as evidence lines. */
function runEvidence(id: string, version: string, since?: string): string[] {
  return readRunRecords()
    .filter((r) => r.feature === id && r.harness === version && (!since || r.ts >= since))
    .map(
      (r) =>
        `${id} attempt ${r.attempt} on v${version}: ${r.outcome}${r.verdict ? ` (${r.verdict})` : ''}${r.note ? ` — ${r.note.slice(0, 200)}` : ''}${r.trace ? ` · trace \`${path.relative(ROOT, r.trace)}\`` : ''}`,
    )
}

/** Quarantines `version`; a failure to file is notified, never thrown. */
function quarantineRelease(r: Parameters<typeof quarantine>[1]): void {
  try {
    const filed = quarantine(project, r)
    record({
      ts: new Date().toISOString(),
      feature: 'harness',
      attempt: 1,
      outcome: 'quarantined',
      pr: filed.url,
      costUsd: 0,
      turns: 0,
      minutes: 0,
      trace: '',
      note: `v${r.version}: ${r.cause} (${filed.action})`,
    })
    notify(`harness v${r.version} quarantined: ${r.cause} — ${filed.url}`)
  } catch (error) {
    notify(
      `harness v${r.version} should be quarantined (${r.cause}) but filing failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * The restarted driver exited with an error before it settled its probation: the new version
 * crashed. This driver (the previous version) rolls back, then checks that its own preflight
 * passes; only then is the new version to blame and quarantined. False stops the loop.
 */
async function rollbackCrashed(
  opts: Options,
  probation: { version: string; from: string },
  child: { code: number; since: string },
): Promise<boolean> {
  const { version, from } = probation
  notify(
    `the driver on harness v${version} exited with code ${child.code} before its first feature settled; rolling back to v${from}`,
  )
  const moved = await pinPr(
    from,
    version,
    opts,
    `the driver on v${version} exited with code ${child.code}`,
  )
  if (moved.state !== 'merged') {
    notify(`the rollback to v${from} did not merge; stopping the loop`)
    return false
  }
  takeUpdate(version, from, moved.pr)
  try {
    preflight(opts)
  } catch (error) {
    notify(
      `preflight fails on v${from} too (${error instanceof Error ? error.message : String(error)}); v${version} is not quarantined and the loop stops`,
    )
    return false
  }
  quarantineRelease({
    version,
    from,
    cause: `the loop driver exits with code ${child.code}`,
    evidence: [
      `the loop driver on v${version} exited with code ${child.code} before its first feature settled; the preflight of v${from} passes in the same checkout`,
      ...readRunRecords()
        .filter((r) => r.ts >= child.since && r.harness === version)
        .map((r) => `${r.feature}: ${r.outcome}${r.note ? ` — ${r.note.slice(0, 200)}` : ''}`),
    ],
  })
  return true
}

// ---------------------------------------------------------------------------------------
// Preflight and main loop
// ---------------------------------------------------------------------------------------

function preflight(opts: Options) {
  log('preflight')
  const main = defaultBranch()
  const branch = must('git', ['rev-parse', '--abbrev-ref', 'HEAD'], 'git branch')
  if (branch !== main) throw new Error(`run the driver from ${main} (current: ${branch})`)
  const problem = (message: string) => {
    if (!opts.dryRun) throw new Error(message)
    log(`warning (ignored in --dry-run): ${message}`)
  }
  if (sh('git', ['status', '--porcelain'], { quiet: true }).out)
    problem('working tree must be clean')
  if (!opts.dryRun) must('git', ['fetch', remote(), main], 'git fetch')
  const tracking = `${remote()}/${main}`
  const ahead = sh('git', ['rev-list', '--count', `${tracking}..${main}`], { quiet: true }).out
  const behind = sh('git', ['rev-list', '--count', `${main}..${tracking}`], { quiet: true }).out
  if (ahead !== '0' || behind !== '0')
    problem(
      `${main} is ${ahead} ahead / ${behind} behind ${tracking}; push or pull first so PRs have the right base`,
    )
  const health = doctor(project)
  for (const line of health.lines.filter((l) => l.status !== 'ok'))
    log(`doctor: ${line.status} ${line.text}`)
  if (!health.ok) throw new Error('pnpm harness:doctor reports errors; fix them first')
  if (sh('claude', ['--version'], { quiet: true }).code !== 0)
    throw new Error('claude CLI not found')
  // A CLI too old for a pinned model fails every session with a 400, which would burn
  // attempts and auto-block features; one tiny request per model catches it up front.
  if (!opts.dryRun) {
    for (const model of new Set([config.generator.model, config.evaluator.model])) {
      const probe = sh(
        'claude',
        ['-p', 'Reply with: ok', '--model', model, '--max-turns', '1', '--output-format', 'json'],
        { quiet: true, cwd: tmpdir() },
      )
      let result: { is_error?: boolean; result?: string } = {}
      try {
        result = JSON.parse(probe.out) as typeof result
      } catch {
        result = { is_error: true, result: probe.err || probe.out }
      }
      if (probe.code !== 0 || result.is_error)
        throw new Error(`claude cannot run model ${model}: ${result.result ?? probe.err}`)
    }
  }
  if (!ghAvailable())
    log(
      'warning: gh is not installed or not logged in — branches will be pushed but PRs must be opened by hand',
    )
  const services = config.services
  if (opts.services && services) {
    if (shellLine(services.check, ROOT).code !== 0)
      throw new Error(
        `${services.name} is not running (\`${services.check}\` failed; needed for ${config.verify.dockerLayers.join('/')}); pass --no-docker for unit-only features`,
      )
    if (!opts.dryRun && services.up) {
      const up = shellLine(services.up, ROOT)
      if (up.code !== 0) throw new Error(`${services.up} failed: ${up.err || up.out}`)
    }
  }
  log('preflight ok')
}

export async function loopCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      once: { type: 'boolean', default: false },
      feature: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'auto-merge': { type: 'boolean', default: false },
      'no-wait': { type: 'boolean', default: false },
      'no-docker': { type: 'boolean', default: false },
      report: { type: 'boolean', default: false },
    },
  })
  const opts: Options = {
    once: values.once || Boolean(values.feature),
    feature: values.feature,
    dryRun: values['dry-run'],
    autoMerge: values['auto-merge'],
    wait: !values['no-wait'],
    services: !values['no-docker'],
  }
  project = loadProject()
  config = project.config
  ROOT = project.root
  if (values.report) {
    report()
    return 0
  }

  process.on('SIGINT', () => {
    aborting = true
    log('SIGINT: finishing the current session, then stopping')
    currentChild?.kill('SIGINT')
  })

  const carried = process.env[CARRY_ENV]
  delete process.env[CARRY_ENV]
  if (carried) log(`restarted on harness v${packageVersion()}`)
  preflight(opts)
  const carry = readCarry(carried)
  let consecutiveFailures = carry.consecutiveFailures
  let retros = carry.retros
  const attempted = new Set(carry.attempted)
  const intakeIssues = new Set(carry.intakeIssues)

  /** A retro when one is due; failures are logged, never fatal to the loop. */
  const retroIfDue = (trigger: 'every' | 'queue-empty'): boolean => {
    if (opts.dryRun || retros >= config.retro.maxPerLoop) return false
    const since = readRetroState(project).featuresSince
    const due =
      trigger === 'every'
        ? config.retro.every > 0 && since >= config.retro.every
        : config.retro.onQueueEmpty && since > 0
    if (!due) return false
    retros += 1
    log(`=== retro (${trigger}, ${since} feature run(s) since the last one)`)
    try {
      runRetro(project, { log })
    } catch (error) {
      log(`retro failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  }

  const snapshot = (): Carry => ({
    ...carry,
    attempted: [...attempted],
    intakeIssues: [...intakeIssues],
    retros,
    consecutiveFailures,
  })

  for (;;) {
    // No update while a re-test runs: it must run on the version it rolled back to.
    if (!carry.retry && (await maybeUpdate(opts, carry))) {
      const probation = carry.probation
      const child = restart(snapshot())
      await new Promise((resolve) => setImmediate(resolve)) // let a pending SIGINT handler run
      const verdict = supervise({
        code: child.code,
        aborted: aborting || child.signal !== null,
        probation,
        records: readRunRecords().filter((r) => r.ts >= child.since),
      })
      if (verdict === 'exit' || !probation) return child.code
      carry.probation = undefined
      if (!(await rollbackCrashed(opts, probation, child))) break
      continue
    }
    if (aborting) break
    const list = readFeatureList(project.resolve(config.project.featureList), config.features)
    const inFlight = inFlightIds()
    let feature: Feature | undefined
    let intake: IntakeItem | undefined
    const retry = carry.retry
    if (retry) {
      feature = retryFeature(retry, list)
      intake = retry.intake
      if (!feature) {
        log(`re-test of ${retry.feature} skipped: it is no longer in the feature list`)
        carry.retry = undefined
        continue
      }
      log(
        `=== re-test: ${feature.id} on harness v${packageVersion()} (it did not pass on v${retry.suspect})`,
      )
    } else {
      if (!opts.feature && config.retro.intake) {
        try {
          const ids = [...list.features.map((f) => f.id), ...inFlight]
          const priority = Math.max(0, ...list.features.map((f) => f.priority))
          intake = nextIntake(project, ids, priority)
          // Dry run: nothing is queued, so the same issue would come back every iteration.
          if (intake && intakeIssues.has(intake.issue)) intake = undefined
        } catch (error) {
          log(`retro intake skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (intake) {
        feature = intake.feature
        intakeIssues.add(intake.issue)
        log(`retro intake: ${intake.url} → ${feature.id} — ${feature.title}`)
        if (!opts.dryRun) markQueued(project, intake, branchFor(feature.id))
      } else if (opts.feature) {
        feature = list.features.find((f) => f.id === opts.feature)
        if (!feature) throw new Error(`unknown feature ${opts.feature}`)
        if (!isReady(feature, list)) {
          const byId = new Map(list.features.map((f) => [f.id, f]))
          const waiting = feature.depends_on.filter((d) => byId.get(d)?.status !== 'passing')
          throw new Error(
            `${opts.feature} is not ready: status ${feature.status}` +
              (waiting.length ? `, waiting on ${waiting.join(', ')}` : ''),
          )
        }
        if (isHumanOnly(feature))
          throw new Error(`${opts.feature} has manual verification steps; run it interactively`)
      } else {
        feature = nextReadyFeature(list, { exclude: [...inFlight, ...attempted] })
      }
    }
    if (!feature) {
      // A retro may file issues the intake picks up; look again before stopping.
      if (retroIfDue('queue-empty') && config.retro.intake) continue
      notify(queueEmptyNotice(inFlight, list, config.project.branchPrefix))
      break
    }
    attempted.add(feature.id)
    const probation = carry.probation
    const started = new Date().toISOString()
    let outcome: IterationOutcome | 'error'
    let failure: string | undefined
    try {
      outcome = await runFeature(feature, opts, intake)
    } catch (error) {
      if (!probation && !retry) throw error
      outcome = 'error'
      failure = error instanceof Error ? error.message : String(error)
      log(`${feature.id}: driver error — ${failure}`)
    }
    if (outcome === 'aborted') break

    if (probation) {
      const result = probationResult(outcome)
      if (result === 'passed') {
        carry.probation = undefined
        log(`harness v${probation.version} passed its probation on ${feature.id}`)
        record({
          ts: new Date().toISOString(),
          feature: 'harness',
          attempt: 1,
          outcome: 'probation-ok',
          costUsd: 0,
          turns: 0,
          minutes: 0,
          trace: '',
          note: `${feature.id} passed on v${probation.version}`,
        })
      } else if (result === 'suspect') {
        carry.probation = undefined
        const evidence = [
          ...runEvidence(feature.id, probation.version, started),
          ...(failure ? [`${feature.id} on v${probation.version}: driver error — ${failure}`] : []),
        ]
        evidence.push(`the run is kept as branch \`${setAside(feature.id, probation.version)}\``)
        notify(
          `${feature.id} ${outcome} on harness v${probation.version}, its first feature after the update; rolling back to v${probation.from} to re-test it there`,
        )
        const moved = await pinPr(
          probation.from,
          probation.version,
          opts,
          `v${probation.version} failed its probation on ${feature.id}`,
        )
        if (moved.state !== 'merged') {
          notify(
            `the rollback to v${probation.from} did not merge; stopping the loop so nothing more runs on v${probation.version}`,
          )
          break
        }
        takeUpdate(probation.version, probation.from, moved.pr)
        attempted.delete(feature.id)
        carry.retry = {
          feature: feature.id,
          suspect: probation.version,
          from: probation.from,
          evidence,
          intake,
        }
        return restart(snapshot()).code
      }
    }
    if (retry) {
      carry.retry = undefined
      const evidence = [...retry.evidence, ...runEvidence(feature.id, packageVersion(), started)]
      if (outcome === 'done') {
        quarantineRelease({
          version: retry.suspect,
          from: retry.from,
          cause: `${feature.id} did not pass on v${retry.suspect} and passed on v${retry.from}`,
          evidence: [...evidence, `${feature.id} on v${retry.from}: done`],
        })
      } else {
        record({
          ts: new Date().toISOString(),
          feature: 'harness',
          attempt: 1,
          outcome: 'probation-cleared',
          costUsd: 0,
          turns: 0,
          minutes: 0,
          trace: '',
          note: `${feature.id} did not pass on v${retry.from} either; v${retry.suspect} is not to blame`,
        })
        notify(
          `${feature.id} did not pass on v${retry.from} either, so harness v${retry.suspect} is not to blame; a later loop run may take it again`,
        )
      }
      if (failure) throw new Error(failure)
    }
    if (!opts.dryRun) countFeatureRun(project)
    retroIfDue('every')
    consecutiveFailures = outcome === 'done' ? 0 : consecutiveFailures + 1
    if (consecutiveFailures >= config.caps.maxConsecutiveFailures) {
      notify(`${consecutiveFailures} consecutive failures — stopping the loop`)
      break
    }
    if (opts.once) break
  }
  log(`loop finished on ${today()}; run pnpm harness:report for the summary`)
  return 0
}

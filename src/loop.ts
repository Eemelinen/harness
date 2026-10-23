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
 */
import { spawn } from 'node:child_process'
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

import { cleanState } from './clean-state'
import { loadProject, worktreeRoot, type HarnessConfig, type Project } from './config'
import { doctor } from './doctor'
import { describeEvent, heartbeat, newStreamState } from './events'
import {
  FEATURE_ID,
  isHumanOnly,
  isReady,
  nextReadyFeature,
  readFeatureList,
  today,
  type Feature,
} from './feature-list'
import { PACKAGE_ROOT, sh as run, shellLine } from './run'

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
  /** The final `result` message of the stream (or the single JSON result). */
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
      if (msg.type === 'result') result = msg
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

/** The plugin of the harness version installed in `dir` (a worktree may pin a newer one). */
export function pluginDir(dir: string): string {
  try {
    const require = createRequire(path.join(dir, 'package.json'))
    return path.join(path.dirname(require.resolve('@eemelinen/harness/package.json')), 'plugin')
  } catch {
    return path.join(PACKAGE_ROOT, 'plugin')
  }
}

// ---------------------------------------------------------------------------------------
// Git / worktree / GitHub
// ---------------------------------------------------------------------------------------

function branchFor(id: string) {
  return `${config.project.branchPrefix}${id}`
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

// ---------------------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------------------

interface RunRecord {
  ts: string
  feature: string
  attempt: number
  outcome: 'pr' | 'merged' | 'blocked' | 'failed' | 'aborted' | 'pushed'
  verdict?: string
  pr?: string
  costUsd: number
  turns: number
  minutes: number
  trace: string
  note?: string
}

function record(rec: RunRecord) {
  const file = path.join(ROOT, config.runsLog)
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(rec)}\n`)
}

function report() {
  const file = path.join(ROOT, config.runsLog)
  if (!existsSync(file)) {
    console.log('no runs recorded yet')
    return
  }
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunRecord)
  console.log('when              feature attempt outcome  verdict  turns  cost   min  pr')
  for (const r of rows) {
    console.log(
      `${r.ts.slice(0, 16).replace('T', ' ')} ${r.feature}   ${String(r.attempt).padEnd(7)} ${r.outcome.padEnd(8)} ${(r.verdict ?? '-').padEnd(8)} ${String(r.turns).padStart(5)}  $${r.costUsd.toFixed(2).padStart(5)} ${String(r.minutes).padStart(4)}  ${r.pr ?? ''}`,
    )
  }
  const total = rows.reduce((s, r) => s + r.costUsd, 0)
  console.log(`\n${rows.length} run(s) · total $${total.toFixed(2)}`)
}

// ---------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------

function generatorTemplate(): string {
  const template = readFileSync(path.join(PACKAGE_ROOT, 'prompts', 'generator.md'), 'utf8')
  const notesFile = config.prompts.generatorNotes
  const notes = notesFile ? readFileSync(path.join(ROOT, notesFile), 'utf8').trim() : ''
  return render(template, {
    PROJECT_NAME: config.project.name,
    PROJECT_NOTES: notes ? `\nProject notes (\`${notesFile}\`):\n\n${notes}\n` : '',
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

async function runFeature(feature: Feature, opts: Options): Promise<IterationOutcome> {
  const id = feature.id
  const started = Date.now()
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
  if (!opts.dryRun) {
    logFile = path.join(ROOT, config.traceDir, `${id}-${stamp()}.log`)
    mkdirSync(path.dirname(logFile), { recursive: true })
    log(`${id} — ${feature.title}; readable log: ${path.relative(ROOT, logFile)}`)
  }
  const dir = ensureWorktree(id, opts.dryRun)
  const plugin = pluginDir(opts.dryRun ? ROOT : dir)
  const template = generatorTemplate()
  const evaluatorTemplate = readFileSync(path.join(PACKAGE_ROOT, 'prompts', 'evaluator.md'), 'utf8')
  const schema = readFileSync(path.join(PACKAGE_ROOT, 'prompts', 'evaluator-schema.json'), 'utf8')
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
    const generatorArgs = [
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
        `would then: git push -u ${remote()} ${branchFor(id)} && gh pr create --base ${defaultBranch()} --head ${branchFor(id)} …; merge policy ${opts.autoMerge ? 'auto' : config.merge}`,
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

    // Evaluator: fresh context, read-only. `--agent` ignores `--json-schema`, so the agent
    // file's instructions and tool list are passed directly (see evaluatorAgent()).
    log(`=== ${id}: evaluator session (${config.evaluator.model})`)
    const agent = evaluatorAgent(plugin)
    const evalArgs = [
      '-p',
      render(evaluatorTemplate, {
        FEATURE_ID: id,
        FEATURE_TITLE: feature.title,
        BASE: `${remote()}/${defaultBranch()}`,
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
      schema,
    ]
    const evalTrace = path.join(ROOT, config.traceDir, `${id}-${stamp()}.evaluator.json`)
    const ev = await runClaude({
      cwd: dir,
      args: evalArgs,
      env: { HARNESS_LOOP: '1' },
      traceFile: evalTrace,
      wallClockMs: config.evaluator.wallClockMin * 60_000,
      stream: false,
    })
    const verdict = parseVerdict(ev.result)
    const evalCost = Number(ev.result?.total_cost_usd ?? 0)
    log(`evaluator finished: ${describeResult(ev)} → ${verdict?.verdict ?? 'no verdict'}`)
    if (verdict) for (const line of verdictLines(verdict)) log(`  ${line}`)

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

    // Accept → publish.
    const pr = publish(
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
    )
    record({
      ts: new Date().toISOString(),
      feature: id,
      attempt,
      outcome: pr ? 'pr' : 'pushed',
      verdict: 'Accept',
      pr,
      costUsd: cost + evalCost,
      turns,
      minutes: minutes(),
      trace: traceFile,
    })
    if (pr && (config.merge !== 'none' || opts.autoMerge) && opts.wait) {
      await waitForMerge(pr, opts.autoMerge || config.merge === 'auto')
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

function pushBranch(id: string, dir: string) {
  const r = sh('git', ['push', '-u', remote(), branchFor(id)], { cwd: dir, quiet: true })
  if (r.code !== 0) log(`git push failed: ${r.err}`)
}

function publish(
  id: string,
  dir: string,
  feature: Feature,
  finished: Feature | undefined,
  verdict: Verdict,
  stats: { cost: number; turns: number; trace: string },
  opts: Options,
): string | undefined {
  pushBranch(id, dir)
  if (!ghAvailable()) {
    log(`gh is not available; branch ${branchFor(id)} pushed — open the PR by hand`)
    return undefined
  }
  const body = [
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
    return undefined
  }
  const url = r.out.split('\n').find((l) => l.startsWith('https://')) ?? r.out
  log(`PR opened: ${url}`)
  if (opts.autoMerge || config.merge === 'auto') {
    const m = sh('gh', ['pr', 'merge', url, '--auto', '--squash', '--delete-branch'], {
      cwd: dir,
      quiet: true,
    })
    if (m.code !== 0) log(`gh pr merge --auto failed: ${m.err}`)
  }
  return url
}

async function waitForMerge(pr: string, auto: boolean) {
  notify(`PR ready: ${pr}${auto ? ' (auto-merge armed)' : ' — merge it to let the loop continue'}`)
  log(`waiting for ${auto ? 'CI and auto-merge' : 'a human merge'}: ${pr}`)
  const reported = new Set<string>()
  const waitStarted = Date.now()
  for (let poll = 0; ; poll++) {
    const checks = sh('gh', ['pr', 'checks', pr, '--json', 'name,bucket'], { quiet: true })
    let pending = 0
    const failed: string[] = []
    if (checks.out.startsWith('[')) {
      for (const c of JSON.parse(checks.out) as { name: string; bucket: string }[]) {
        if (c.bucket === 'pending') pending++
        if (c.bucket === 'fail' || c.bucket === 'cancel') failed.push(c.name)
        if (c.bucket !== 'pending' && !reported.has(c.name)) {
          reported.add(c.name)
          log(`${c.bucket === 'pass' ? '✓' : '✗'} CI ${c.name}: ${c.bucket}`)
        }
      }
    }
    const r = sh('gh', ['pr', 'view', pr, '--json', 'state,mergedAt'], { quiet: true })
    if (r.code === 0) {
      const info = JSON.parse(r.out) as { state: string }
      if (info.state === 'MERGED') {
        log(`PR merged after ${Math.round((Date.now() - waitStarted) / 60000)} min: ${pr}`)
        return
      }
      if (info.state === 'CLOSED') throw new Error(`PR ${pr} was closed without merging`)
    }
    // Auto-merge never fires on a red check, so waiting longer only hangs the loop. A fix pushed
    // to the branch still merges the PR; the next loop run starts from the merged branch.
    if (auto && pending === 0 && failed.length > 0) {
      notify(`CI failed on ${pr} (${failed.join(', ')}) — fix the branch; auto-merge stays armed`)
      throw new Error(`CI failed on ${pr}: ${failed.join(', ')}`)
    }
    if (poll > 0 && poll % 5 === 0)
      log(
        `… still waiting for the merge (${Math.round((Date.now() - waitStarted) / 60000)} min, ${pending} check(s) pending)`,
      )
    if (aborting) throw new Error('aborted while waiting for merge')
    await sleep(60_000)
  }
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

  preflight(opts)
  let consecutiveFailures = 0
  const attempted = new Set<string>()
  for (;;) {
    const list = readFeatureList(project.resolve(config.project.featureList), config.features)
    const inFlight = inFlightIds()
    let feature: Feature | undefined
    if (opts.feature) {
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
    if (!feature) {
      const waiting = inFlight.length
        ? ` (${inFlight.join(', ')} in flight — merge their PRs to unblock dependents)`
        : ''
      notify(`queue empty${waiting}`)
      break
    }
    attempted.add(feature.id)
    const outcome = await runFeature(feature, opts)
    if (outcome === 'aborted') break
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

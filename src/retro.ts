/**
 * `harness retro`: the loop looks back at its own runs. It collects what went wrong in the harness
 * rather than in the feature (guard blocks, permission denials, driver errors, evaluator revisions,
 * failed attempts, sessions near their caps) from the traces since the last retro, has a read-only
 * session sort them into harness defects and project setup problems, and files each as an issue in
 * the repository that owns the fix. With `retro.intake`, that repository's loop turns open retro
 * issues into features (docs/self-improvement.md).
 *
 *   harness retro                collect, analyse, file
 *   harness retro --dry-run      collect and analyse; print the findings, file nothing
 *   harness retro --signals      print the collected signals only (no session, no cost)
 *   harness retro --since <iso>  look back to this time instead of the last retro
 */
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { z } from 'zod'

import { loadProject, type HarnessConfig, type Project } from './config'
import { FEATURE_ID, type Feature } from './feature-list'
import { PACKAGE_ROOT, sh } from './run'

// ---------------------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------------------

export type SignalKind =
  | 'guard-block'
  | 'permission-denial'
  | 'driver-error'
  | 'evaluator-revise'
  | 'attempt-failed'
  | 'feature-blocked'
  | 'ci-fix'
  | 'near-cap'

export interface SignalExample {
  feature: string
  /** Trace or log file, relative to the project root. */
  source: string
  /** Subagent type when a subagent made the call (`harness:evaluator`), else `main`. */
  agent?: string
  command?: string
  detail: string
}

export interface Signal {
  kind: SignalKind
  summary: string
  count: number
  features: string[]
  examples: SignalExample[]
}

const MAX_EXAMPLES = 3
const MAX_SIGNALS = 60

export type Signals = Map<string, Signal>

/** Wording that differs only in quoted text, numbers or paths groups into one signal. */
export function normalizeSummary(text: string): string {
  return text
    .toLowerCase()
    .replace(/(['"`]).*?\1/g, '…')
    .replace(/(^|\s)\/[\w./@+-]+/g, '$1/…')
    .replace(/\d+/g, 'n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

export function addSignal(
  signals: Signals,
  kind: SignalKind,
  summary: string,
  example: SignalExample,
) {
  const key = `${kind}:${normalizeSummary(summary)}`
  let signal = signals.get(key)
  if (!signal) {
    signal = { kind, summary: oneLine(summary, 300), count: 0, features: [], examples: [] }
    signals.set(key, signal)
  }
  signal.count += 1
  if (!signal.features.includes(example.feature)) signal.features.push(example.feature)
  if (signal.examples.length < MAX_EXAMPLES)
    signal.examples.push({
      ...example,
      command: example.command === undefined ? undefined : example.command.slice(0, 400),
      detail: example.detail.slice(0, 600),
    })
}

/** Most frequent first, capped so the analysis prompt stays small. */
export function signalList(signals: Signals): Signal[] {
  return [...signals.values()]
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
    .slice(0, MAX_SIGNALS)
}

const oneLine = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max)

const featureOf = (file: string) => /^(F-\d{3})-/.exec(path.basename(file))?.[1] ?? 'loop'

/** The reason a PreToolUse hook gave for blocking a call, from the failed tool result's text. */
export function hookBlockReason(text: string): string | undefined {
  const hook = /hook error: \[.*?\]: ([^\n]+)/.exec(text)
  if (hook?.[1]) return hook[1].trim()
  return /^guard: (.+)$/m.exec(text)?.[0]?.trim()
}

const PERMISSION_DENIED = /permission[^\n]*denied|denied by[^\n]*classifier|requires approval/i

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((c: { text?: unknown }) => (typeof c?.text === 'string' ? c.text : ''))
      .join('\n')
  return ''
}

function commandOf(input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>
  const value = i.command ?? i.file_path ?? i.pattern ?? i.url
  return typeof value === 'string' ? value : undefined
}

type Json = Record<string, unknown>

/** Guard blocks and permission denials in one `stream-json` session trace. */
export function collectStreamTrace(text: string, source: string, signals: Signals) {
  const feature = featureOf(source)
  const uses = new Map<string, { input: unknown; agent: string }>()
  const subagents = new Map<string, string>()
  const counted = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let msg: Json
    try {
      msg = JSON.parse(line) as Json
    } catch {
      continue
    }
    const parent = typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : undefined
    if (msg.type === 'result' && Array.isArray(msg.permission_denials)) {
      for (const d of msg.permission_denials as Json[]) {
        const id = String(d.tool_use_id ?? '')
        if (counted.has(id)) continue
        addSignal(signals, 'permission-denial', `${String(d.tool_name)} call denied`, {
          feature,
          source,
          agent: uses.get(id)?.agent,
          command: commandOf(d.tool_input),
          detail: 'listed in the session result (permission_denials)',
        })
      }
      continue
    }
    const content = (msg.message as Json | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Json[]) {
      if (block.type === 'tool_use') {
        const id = String(block.id)
        uses.set(id, {
          input: block.input,
          agent: parent ? (subagents.get(parent) ?? 'subagent') : 'main',
        })
        if (block.name === 'Agent' || block.name === 'Task') {
          const input = (block.input ?? {}) as Json
          subagents.set(id, String(input.subagent_type ?? 'general-purpose'))
        }
      }
      if (block.type !== 'tool_result' || block.is_error !== true) continue
      const id = String(block.tool_use_id)
      const use = uses.get(id)
      const text = resultText(block.content)
      const example = { feature, source, agent: use?.agent, command: commandOf(use?.input) }
      const reason = hookBlockReason(text)
      if (reason) {
        counted.add(id)
        addSignal(signals, 'guard-block', reason, { ...example, detail: oneLine(text, 600) })
      } else if (PERMISSION_DENIED.test(text)) {
        counted.add(id)
        addSignal(signals, 'permission-denial', text.split('\n')[0] ?? text, {
          ...example,
          detail: oneLine(text, 600),
        })
      }
    }
  }
}

/** A non-Accept verdict and the evaluator's own denials from its JSON result. */
export function collectEvaluator(text: string, source: string, signals: Signals) {
  let result: Json
  try {
    result = JSON.parse(text) as Json
  } catch {
    return // still being written, or not JSON
  }
  const feature = featureOf(source)
  const verdict = result.structured_output as
    | {
        verdict?: string
        findings?: { severity?: string; note?: string }[]
        required_follow_up?: string[]
      }
    | undefined
  if (verdict?.verdict && verdict.verdict !== 'Accept') {
    const asks = verdict.required_follow_up ?? []
    const majors = (verdict.findings ?? [])
      .filter((f) => f.severity !== 'minor')
      .map((f) => f.note ?? '')
    addSignal(
      signals,
      'evaluator-revise',
      `evaluator ${verdict.verdict}: ${asks[0] ?? majors[0] ?? ''}`,
      {
        feature,
        source,
        agent: 'evaluator',
        detail: [...asks, ...majors].join(' · '),
      },
    )
  }
  for (const d of (result.permission_denials as Json[] | undefined) ?? [])
    addSignal(signals, 'permission-denial', `${String(d.tool_name)} call denied`, {
      feature,
      source,
      agent: 'evaluator',
      command: commandOf(d.tool_input),
      detail: 'listed in the evaluator result (permission_denials)',
    })
}

/** Lines the driver itself wrote that report a failure (not the session's narration). */
const DRIVER_LINE = /^\[harness \d\d:\d\d:\d\d\] (.*)$/
const DRIVER_PROBLEM =
  /failed|error|warning|gave up|giving up|stalled|not available|cannot|could not|exhausted/i
const NARRATION = /^(claude:|bash:|tool |  |…|▶|✓|=== )/
/** Failed tool calls; the trace has them with their hook reason, so the log copy is skipped. */
const TOOL_ERROR = /^✗ \w+ error:/
/**
 * `✗`/`⚠` milestone lines report the session's own test runs (red before green is normal). One
 * that names a hook is the driver reporting a blocked command as a test failure.
 */
const MILESTONE = /^[✗⚠] /

export function collectDriverLog(text: string, source: string, signals: Signals) {
  const feature = featureOf(source)
  for (const line of text.split('\n')) {
    const msg = DRIVER_LINE.exec(line)?.[1]
    if (!msg || NARRATION.test(msg) || TOOL_ERROR.test(msg) || !DRIVER_PROBLEM.test(msg)) continue
    if (MILESTONE.test(msg) && !/hook/i.test(msg)) continue
    addSignal(signals, 'driver-error', msg, { feature, source, detail: oneLine(msg, 600) })
  }
}

interface RunLine {
  ts: string
  feature: string
  outcome: string
  costUsd: number
  turns: number
  minutes: number
  trace: string
  note?: string
}

export function collectRuns(
  rows: RunLine[],
  caps: HarnessConfig['caps'],
  root: string,
  signals: Signals,
) {
  for (const r of rows) {
    const source = path.relative(root, r.trace)
    const example = { feature: r.feature, source, detail: r.note || r.outcome }
    if (r.outcome === 'failed')
      addSignal(signals, 'attempt-failed', r.note || 'attempt failed', example)
    if (r.outcome === 'blocked') addSignal(signals, 'feature-blocked', r.note || 'blocked', example)
    if (r.outcome === 'ci-fix' || r.outcome === 'ci-rerun')
      addSignal(signals, 'ci-fix', `${r.outcome}: ${r.note ?? ''}`, example)
    const nearCap =
      r.turns >= caps.maxTurns * 0.8 ||
      r.costUsd >= caps.maxBudgetUsd * 0.8 ||
      r.minutes >= caps.wallClockMin * 0.8
    if (nearCap)
      addSignal(
        signals,
        'near-cap',
        'a session used over 80% of a cap (turns, budget or wall clock)',
        {
          ...example,
          detail: `${r.turns}/${caps.maxTurns} turns · $${r.costUsd.toFixed(2)}/$${caps.maxBudgetUsd} · ${r.minutes}/${caps.wallClockMin} min`,
        },
      )
  }
}

/** Every signal in the traces, logs and run records newer than `since`. */
export function collectSignals(project: Project, since: Date): Signal[] {
  const { config, root } = project
  const signals: Signals = new Map()
  const traceDir = project.resolve(config.traceDir)
  if (existsSync(traceDir)) {
    for (const name of readdirSync(traceDir).sort()) {
      const file = path.join(traceDir, name)
      if (statSync(file).mtime < since) continue
      const source = path.relative(root, file)
      const text = readFileSync(file, 'utf8')
      if (name.endsWith('.jsonl')) collectStreamTrace(text, source, signals)
      else if (name.endsWith('.evaluator.json')) collectEvaluator(text, source, signals)
      else if (name.endsWith('.log')) collectDriverLog(text, source, signals)
    }
  }
  const runsFile = project.resolve(config.runsLog)
  if (existsSync(runsFile)) {
    const rows = readFileSync(runsFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RunLine)
      .filter((r) => r.feature !== 'retro' && new Date(r.ts) >= since)
    collectRuns(rows, config.caps, root, signals)
  }
  return signalList(signals)
}

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------

export interface RetroState {
  /** When the last retro finished; signals before it were already looked at. */
  lastRun?: string
  /** Features the loop ran since then. */
  featuresSince: number
}

const retroDir = (project: Project) =>
  project.resolve(path.dirname(project.config.runsLog), 'retro')

export function readRetroState(project: Project): RetroState {
  try {
    return JSON.parse(
      readFileSync(path.join(retroDir(project), 'state.json'), 'utf8'),
    ) as RetroState
  } catch {
    return { featuresSince: 0 }
  }
}

export function writeRetroState(project: Project, state: RetroState) {
  mkdirSync(retroDir(project), { recursive: true })
  writeFileSync(path.join(retroDir(project), 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
}

export function countFeatureRun(project: Project) {
  const state = readRetroState(project)
  writeRetroState(project, { ...state, featuresSince: state.featuresSince + 1 })
}

// ---------------------------------------------------------------------------------------
// Findings and issues
// ---------------------------------------------------------------------------------------

const findingSchema = z.object({
  fingerprint: z.string().regex(/^[a-z0-9][a-z0-9-]{2,60}$/),
  target: z.enum(['harness', 'project']),
  title: z.string().min(1),
  problem: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
  fix: z.string().min(1),
  verification: z.array(z.string().min(1)).default([]),
  safety: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
})

const analysisSchema = z.object({
  summary: z.string(),
  findings: z.array(findingSchema),
})

export type Finding = z.infer<typeof findingSchema>
export type Analysis = z.infer<typeof analysisSchema>

const VERIFICATION_STEP = /^(L1|L2|L3): \S/

/** The feature a retro issue asks for, as the intake reads it back. */
export interface IssueFeature {
  title: string
  user_visible_behavior: string
  verification: string[]
  safety: boolean
}

export const MARKER = 'harness-retro fingerprint:'

export function issueBody(
  finding: Finding,
  ctx: { project: string; version: string; date: string },
) {
  const steps = finding.verification.filter((s) => VERIFICATION_STEP.test(s))
  const feature: IssueFeature = {
    title: finding.title,
    user_visible_behavior: finding.fix,
    verification: steps.length > 0 ? steps : ['L1: pnpm check'],
    safety: finding.safety,
  }
  return [
    finding.problem,
    '',
    `**Evidence** (${ctx.project}, harness ${ctx.version}, ${ctx.date}):`,
    ...finding.evidence.map((e) => `- ${e}`),
    '',
    '**Proposed fix**',
    '',
    finding.fix,
    '',
    finding.safety
      ? '> Changes what sessions may do (guard, permissions, settings or the retro itself): the PR waits for a human.\n'
      : '',
    'The loop turns this issue into a feature (`retro.intake`). Edit the block to change what it builds; close the issue as not planned to reject it.',
    '',
    '```json harness-feature',
    JSON.stringify(feature, null, 2),
    '```',
    '',
    `<!-- ${MARKER} ${finding.fingerprint} -->`,
  ].join('\n')
}

export function fingerprintOf(body: string): string | undefined {
  return new RegExp(`<!-- ${MARKER} ([a-z0-9-]+) -->`).exec(body)?.[1]
}

export function parseIssueFeature(body: string): IssueFeature | undefined {
  const block = /```json harness-feature\r?\n([\s\S]*?)\r?\n```/.exec(body)?.[1]
  if (!block) return undefined
  try {
    const raw = JSON.parse(block) as Partial<IssueFeature>
    if (typeof raw.title !== 'string' || !raw.title.trim()) return undefined
    if (typeof raw.user_visible_behavior !== 'string' || !raw.user_visible_behavior.trim())
      return undefined
    const steps = (Array.isArray(raw.verification) ? raw.verification : []).filter(
      (s): s is string => typeof s === 'string' && VERIFICATION_STEP.test(s),
    )
    return {
      title: raw.title.trim(),
      user_visible_behavior: raw.user_visible_behavior.trim(),
      verification: steps.length > 0 ? steps : ['L1: pnpm check'],
      safety: raw.safety === true,
    }
  } catch {
    return undefined
  }
}

/** The issue text above the feature block (problem, evidence, proposed fix), trimmed for notes. */
export function issueContext(body: string): string {
  return (body.split('```json harness-feature')[0] ?? '').trim().slice(0, 3000)
}

/** The next free `F-NNN` above every id in use (the feature list, open branches). */
export function nextFeatureId(ids: Iterable<string>): string {
  let max = 0
  for (const id of ids) if (FEATURE_ID.test(id)) max = Math.max(max, Number(id.slice(2)))
  return `F-${String(max + 1).padStart(3, '0')}`
}

/** `owner/name` of a GitHub remote URL. */
export function repoSlug(url: string): string | undefined {
  return /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1]
}

const packageJson = () =>
  JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    version: string
    repository?: { url?: string }
  }

export function harnessRepo(config: HarnessConfig): string | undefined {
  return config.retro.harnessRepo ?? repoSlug(packageJson().repository?.url ?? '')
}

export function projectRepo(project: Project): string | undefined {
  const r = sh('git', ['remote', 'get-url', project.config.project.remote], {
    cwd: project.root,
    quiet: true,
  })
  return r.code === 0 ? repoSlug(r.out) : undefined
}

export interface Issue {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  stateReason?: string
  body: string
  url: string
  labels: { name: string }[]
}

export function listIssues(
  repo: string,
  label: string,
  state: 'open' | 'all',
  cwd: string,
): Issue[] {
  const r = sh(
    'gh',
    [
      'issue',
      'list',
      '--repo',
      repo,
      '--label',
      label,
      '--state',
      state,
      '--limit',
      '300',
      '--json',
      'number,title,state,stateReason,body,url,labels',
    ],
    { cwd, quiet: true },
  )
  if (r.code !== 0) throw new Error(`gh issue list --repo ${repo} failed: ${r.err}`)
  return JSON.parse(r.out || '[]') as Issue[]
}

export function ensureLabel(repo: string, name: string, description: string, cwd: string) {
  sh(
    'gh',
    [
      'label',
      'create',
      name,
      '--repo',
      repo,
      '--color',
      'C5DEF5',
      '--description',
      description,
      '--force',
    ],
    { cwd, quiet: true },
  )
}

export type FilingAction = 'filed' | 'seen-again' | 'recurred' | 'rejected-before' | 'not-filed'

export interface Filed {
  finding: Finding
  action: FilingAction
  repo?: string
  url?: string
}

function fileFindings(project: Project, analysis: Analysis, version: string): Filed[] {
  const { config, root } = project
  const label = config.retro.label
  const repos = { harness: harnessRepo(config), project: projectRepo(project) }
  const existing = new Map<string, Issue[]>()
  const issuesOf = (repo: string) => {
    if (!existing.has(repo)) existing.set(repo, listIssues(repo, label, 'all', root))
    return existing.get(repo) ?? []
  }
  const ctx = { project: config.project.name, version, date: new Date().toISOString().slice(0, 10) }
  const out: Filed[] = []
  for (const finding of analysis.findings) {
    const repo = repos[finding.target]
    if (finding.confidence === 'low' || !repo) {
      out.push({ finding, action: 'not-filed', repo })
      continue
    }
    const match = issuesOf(repo).find((i) => fingerprintOf(i.body) === finding.fingerprint)
    const seen = `Seen again in ${ctx.project} (harness ${ctx.version}, ${ctx.date}):\n${finding.evidence.map((e) => `- ${e}`).join('\n')}`
    if (match && match.state === 'CLOSED' && match.stateReason === 'NOT_PLANNED') {
      out.push({ finding, action: 'rejected-before', repo, url: match.url })
    } else if (match) {
      sh('gh', ['issue', 'comment', String(match.number), '--repo', repo, '--body', seen], {
        cwd: root,
        quiet: true,
      })
      out.push({
        finding,
        action: match.state === 'OPEN' ? 'seen-again' : 'recurred',
        repo,
        url: match.url,
      })
    } else {
      ensureLabel(repo, label, 'Found by harness retro; the loop turns it into a feature', root)
      const labels = [label]
      if (finding.safety) {
        ensureLabel(repo, `${label}:safety`, 'Retro fix that changes what sessions may do', root)
        labels.push(`${label}:safety`)
      }
      const bodyFile = path.join(retroDir(project), `issue-${finding.fingerprint}.md`)
      writeFileSync(bodyFile, issueBody(finding, ctx))
      const r = sh(
        'gh',
        [
          'issue',
          'create',
          '--repo',
          repo,
          '--title',
          `retro: ${finding.title}`,
          '--body-file',
          bodyFile,
          ...labels.flatMap((l) => ['--label', l]),
        ],
        { cwd: root, quiet: true },
      )
      if (r.code !== 0) throw new Error(`gh issue create --repo ${repo} failed: ${r.err}`)
      const url = r.out.split('\n').find((l) => l.startsWith('https://')) ?? r.out
      issuesOf(repo).push({
        number: Number(/(\d+)$/.exec(url)?.[1] ?? 0),
        title: finding.title,
        state: 'OPEN',
        body: issueBody(finding, ctx),
        url,
        labels: labels.map((name) => ({ name })),
      })
      out.push({ finding, action: 'filed', repo, url })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------------------

export interface IntakeItem {
  issue: number
  url: string
  repo: string
  feature: Feature
  safety: boolean
}

export const queuedLabel = (config: HarnessConfig) => `${config.retro.label}:queued`

/**
 * The oldest open retro issue of this repository that is not queued yet, as a new feature.
 * `ids` are the ids in use (feature list, open branches); `priority` is the list's highest.
 */
export function nextIntake(
  project: Project,
  ids: Iterable<string>,
  priority: number,
): IntakeItem | undefined {
  const { config, root } = project
  const repo = projectRepo(project)
  if (!repo) return undefined
  const queued = queuedLabel(config)
  const open = listIssues(repo, config.retro.label, 'open', root)
    .filter((i) => !i.labels.some((l) => l.name === queued))
    .sort((a, b) => a.number - b.number)
  for (const issue of open) {
    const spec = parseIssueFeature(issue.body)
    if (!spec) continue
    const feature: Feature = {
      id: nextFeatureId(ids),
      priority: priority + 1,
      area: 'harness',
      title: spec.title,
      user_visible_behavior: spec.user_visible_behavior,
      status: 'not_started',
      depends_on: [],
      verification: spec.verification,
      evidence: [],
      attempts: 0,
      // Sessions cannot read GitHub, so the issue's problem and evidence travel in the notes.
      notes: `From retro issue ${repo}#${issue.number}: ${issue.url}\n\n${issueContext(issue.body)}`,
    }
    return { issue: issue.number, url: issue.url, repo, feature, safety: spec.safety }
  }
  return undefined
}

/** Shell-`case` glob like the guard's path rules: `*` matches any characters including `/`. */
function globMatches(glob: string, file: string): boolean {
  const body = glob
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${body}$`).test(file)
}

/**
 * Why a loop PR must wait for a human instead of auto-merging: the files it changes under
 * `reviewPaths`, and a retro issue marked as a safety change. Empty when it may auto-merge.
 */
export function reviewReasons(files: string[], reviewPaths: string[], safety = false): string[] {
  const reasons = files
    .filter((f) => reviewPaths.some((glob) => globMatches(glob, f)))
    .map((f) => `changes ${f} (reviewPaths)`)
  if (safety) reasons.unshift('the retro issue is marked as a safety change')
  return reasons
}

export function markQueued(project: Project, item: IntakeItem, branch: string) {
  const queued = queuedLabel(project.config)
  ensureLabel(item.repo, queued, 'A loop branch is working on this retro issue', project.root)
  sh('gh', ['issue', 'edit', String(item.issue), '--repo', item.repo, '--add-label', queued], {
    cwd: project.root,
    quiet: true,
  })
  sh(
    'gh',
    [
      'issue',
      'comment',
      String(item.issue),
      '--repo',
      item.repo,
      '--body',
      `Queued as ${item.feature.id} on \`${branch}\`; its PR closes this issue when it merges.`,
    ],
    { cwd: project.root, quiet: true },
  )
}

// ---------------------------------------------------------------------------------------
// Analysis session and the command
// ---------------------------------------------------------------------------------------

const promptFile = (name: string) => readFileSync(path.join(PACKAGE_ROOT, 'prompts', name), 'utf8')

function openIssueLines(project: Project): string {
  const { config, root } = project
  const lines: string[] = []
  const repos = new Map([
    [harnessRepo(config), 'harness'],
    [projectRepo(project), 'project'],
  ])
  for (const [repo, target] of repos) {
    if (!repo) continue
    try {
      for (const i of listIssues(repo, config.retro.label, 'all', root))
        lines.push(
          `- [${target}] ${repo}#${i.number} ${i.state.toLowerCase()}${i.stateReason ? ` (${i.stateReason.toLowerCase()})` : ''} · fingerprint ${fingerprintOf(i.body) ?? '?'} · ${i.title}`,
        )
    } catch {
      lines.push(`- (could not list ${repo}'s issues)`)
    }
  }
  return lines.join('\n') || '(none)'
}

export interface RetroResult {
  signals: Signal[]
  analysis?: Analysis
  filed: Filed[]
  costUsd: number
  report?: string
}

export interface RetroOptions {
  dryRun?: boolean
  signalsOnly?: boolean
  since?: Date
  log?: (line: string) => void
}

/** One retro: collect, analyse with a read-only session, file. Updates the retro state. */
export function runRetro(project: Project, options: RetroOptions = {}): RetroResult {
  const log = options.log ?? ((line: string) => console.log(line))
  const { config, root } = project
  const started = Date.now()
  const state = readRetroState(project)
  const since = options.since ?? (state.lastRun ? new Date(state.lastRun) : new Date(0))
  const signals = collectSignals(project, since)
  log(`retro: ${signals.length} signal group(s) since ${since.toISOString()}`)
  if (options.signalsOnly) return { signals, filed: [], costUsd: 0 }
  if (signals.length === 0) {
    if (!options.dryRun)
      writeRetroState(project, { lastRun: new Date().toISOString(), featuresSince: 0 })
    return { signals, filed: [], costUsd: 0 }
  }

  const version = packageJson().version
  const prompt = promptFile('retro.md').replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const vars: Record<string, string> = {
      PROJECT_NAME: config.project.name,
      HARNESS_VERSION: version,
      HARNESS_DIR: path.relative(root, PACKAGE_ROOT) || '.',
      HARNESS_REPO: harnessRepo(config) ?? '(unknown)',
      PROJECT_REPO: projectRepo(project) ?? '(unknown)',
      SINCE: since.toISOString(),
      SIGNALS: JSON.stringify(signals, null, 1),
      OPEN_ISSUES: openIssueLines(project),
    }
    return vars[key] ?? ''
  })
  const model = config.retro.model ?? config.evaluator.model
  const effort = config.retro.effort ?? config.evaluator.effort
  const args = [
    '-p',
    prompt,
    '--tools',
    'Read,Glob,Grep',
    '--permission-mode',
    config.generator.permissionMode,
    '--permission-prompts',
    'none',
    '--max-turns',
    String(config.retro.maxTurns),
    '--max-budget-usd',
    String(config.retro.maxBudgetUsd),
    '--model',
    model,
    ...(effort ? ['--effort', effort] : []),
    '--output-format',
    'json',
    '--json-schema',
    promptFile('retro-schema.json'),
  ]
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const traceFile = project.resolve(config.traceDir, `retro-${stamp}.json`)
  log(
    `retro: analysis session (${model}, ≤${config.retro.maxTurns} turns, ≤$${config.retro.maxBudgetUsd})`,
  )
  const res = spawnSync('claude', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HARNESS_LOOP: '1' },
    timeout: config.retro.wallClockMin * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  mkdirSync(path.dirname(traceFile), { recursive: true })
  writeFileSync(traceFile, res.stdout ?? '')
  let result: Json = {}
  try {
    result = JSON.parse(res.stdout ?? '') as Json
  } catch {
    throw new Error(
      `retro session produced no JSON result (${res.stderr?.slice(0, 300) ?? res.error?.message})`,
    )
  }
  const costUsd = Number(result.total_cost_usd ?? 0)
  const parsed = analysisSchema.safeParse(result.structured_output)
  if (!parsed.success)
    throw new Error(`retro session returned no valid analysis: ${z.prettifyError(parsed.error)}`)
  const analysis = parsed.data
  log(
    `retro: ${analysis.findings.length} finding(s), $${costUsd.toFixed(2)} — ${oneLine(analysis.summary, 200)}`,
  )

  const filed: Filed[] = options.dryRun
    ? analysis.findings.map((finding) => ({ finding, action: 'not-filed' }))
    : fileFindings(project, analysis, version)
  for (const f of filed)
    log(
      `  ${f.action.padEnd(15)} [${f.finding.target}/${f.finding.confidence}] ${f.finding.title}${f.url ? ` — ${f.url}` : ''}`,
    )

  const report = path.join(retroDir(project), `${stamp}.md`)
  mkdirSync(retroDir(project), { recursive: true })
  writeFileSync(report, retroReport({ since, signals, analysis, filed, costUsd }))
  if (!options.dryRun) {
    writeRetroState(project, { lastRun: new Date().toISOString(), featuresSince: 0 })
    const runs = project.resolve(config.runsLog)
    mkdirSync(path.dirname(runs), { recursive: true })
    appendFileSync(
      runs,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        feature: 'retro',
        attempt: 0,
        outcome: 'retro',
        costUsd,
        turns: Number(result.num_turns ?? 0),
        minutes: Math.round((Date.now() - started) / 60000),
        trace: traceFile,
        note: `${analysis.findings.length} finding(s), ${filed.filter((f) => f.action === 'filed').length} filed`,
      })}\n`,
    )
  }
  return { signals, analysis, filed, costUsd, report }
}

function retroReport(r: {
  since: Date
  signals: Signal[]
  analysis: Analysis
  filed: Filed[]
  costUsd: number
}): string {
  return [
    `# Retro since ${r.since.toISOString()}`,
    '',
    r.analysis.summary,
    '',
    '## Findings',
    '',
    ...r.filed.flatMap(({ finding: f, action, url }) => [
      `### ${f.title} (${f.target}, ${f.confidence}${f.safety ? ', safety' : ''})`,
      '',
      `${action}${url ? `: ${url}` : ''} · fingerprint \`${f.fingerprint}\``,
      '',
      f.problem,
      '',
      ...f.evidence.map((e) => `- ${e}`),
      '',
      `Fix: ${f.fix}`,
      '',
    ]),
    '## Signals',
    '',
    ...r.signals.map((s) => `- ${s.count}× ${s.kind}: ${s.summary} (${s.features.join(', ')})`),
    '',
    `Cost: $${r.costUsd.toFixed(2)}`,
  ].join('\n')
}

export function retroCommand(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      signals: { type: 'boolean', default: false },
      since: { type: 'string' },
    },
  })
  const since = values.since ? new Date(values.since) : undefined
  if (since && Number.isNaN(since.getTime()))
    throw new Error(`--since ${values.since} is not a date`)
  const project = loadProject()
  const result = runRetro(project, {
    dryRun: values['dry-run'],
    signalsOnly: values.signals,
    since,
  })
  if (values.signals) console.log(JSON.stringify(result.signals, null, 2))
  if (result.report) console.log(`report: ${path.relative(project.root, result.report)}`)
  return 0
}

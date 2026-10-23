/**
 * CI evidence and the fixer's decision table, kept free of process calls so they can be tested.
 * The loop driver (src/loop.ts) runs `gh`, feeds the output in here and acts on the decision.
 */
import type { Feature } from './feature-list'

export interface CiCheck {
  name: string
  /** `gh pr checks` bucket: pass, fail, pending, skipping or cancel. */
  bucket: string
  /** The job URL; a push or a rerun creates a new one, so it identifies one result. */
  link: string
  workflow: string
  runId?: string
}

/** `gh pr checks <pr> --json name,bucket,link,workflow` output; `[]` for anything else. */
export function parseChecks(json: string): CiCheck[] {
  if (!json.trim().startsWith('[')) return []
  const raw = JSON.parse(json) as Partial<CiCheck>[]
  return raw.map((c) => {
    const link = c.link ?? ''
    return {
      name: c.name ?? '?',
      bucket: c.bucket ?? '?',
      link,
      workflow: c.workflow ?? '',
      runId: /\/actions\/runs\/(\d+)/.exec(link)?.[1],
    }
  })
}

export const isFailed = (c: CiCheck) => c.bucket === 'fail' || c.bucket === 'cancel'

/** Distinct workflow run ids of the given checks, in order. */
export function runIds(checks: CiCheck[]): string[] {
  return [...new Set(checks.map((c) => c.runId).filter((id): id is string => Boolean(id)))]
}

export function describeChecks(checks: CiCheck[]): string {
  return checks
    .map(
      (c) => `- ${c.name}${c.workflow ? ` (workflow "${c.workflow}")` : ''}: ${c.bucket} ${c.link}`,
    )
    .join('\n')
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
/** `gh run view --log-failed` prefixes each line with `job<TAB>step<TAB>timestamp `. */
const LOG_PREFIX = /^[^\t]*\t[^\t]*\t(?:\d{4}-\d\d-\d\dT[\d:.]+Z ?)?/
const ERROR_LINE = /\b(?:error|errors|failed|failure|exception|fatal|panic)\b|✗|×|ERR!|##\[error\]/i

/**
 * The part of a failed-job log a fixer needs: every error-looking line with two lines of context
 * (the first 40 hits) plus the tail, prefixes and colour codes removed. Longer output keeps its
 * head and tail, so neither the first error nor the final summary is lost.
 */
export function logExcerpt(
  log: string,
  { maxChars = 12_000, tailLines = 80 }: { maxChars?: number; tailLines?: number } = {},
): string {
  const lines = log
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.replace(LOG_PREFIX, '').trimEnd())
  const keep = new Set<number>()
  let hits = 0
  lines.forEach((line, i) => {
    if (hits >= 40 || !ERROR_LINE.test(line)) return
    hits++
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j)
  })
  for (let i = Math.max(0, lines.length - tailLines); i < lines.length; i++) keep.add(i)
  const out: string[] = []
  let previous = -1
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (previous >= 0 && i > previous + 1) out.push('…')
    out.push(lines[i] ?? '')
    previous = i
  }
  const text = out.join('\n').trim()
  if (text.length <= maxChars) return text
  const half = Math.floor(maxChars / 2)
  return `${text.slice(0, half)}\n… (trimmed) …\n${text.slice(-half)}`
}

export type FixClassification = 'fixed' | 'flaky' | 'out_of_scope'

export interface FixVerdict {
  classification: FixClassification
  reason: string
}

const CLASSIFICATIONS = new Set<string>(['fixed', 'flaky', 'out_of_scope'])

/** The fixer's `CI-FIX-VERDICT: {...}` line (or structured output); undefined when missing. */
export function parseFixVerdict(
  result: Record<string, unknown> | undefined,
): FixVerdict | undefined {
  const structured = result?.structured_output as Partial<FixVerdict> | undefined
  if (structured?.classification && CLASSIFICATIONS.has(structured.classification))
    return { classification: structured.classification, reason: structured.reason ?? '' }
  const text = typeof result?.result === 'string' ? result.result : ''
  const line = [...text.matchAll(/CI-FIX-VERDICT:(.*)/g)].pop()?.[1]?.trim().replace(/`$/, '')
  if (!line) return undefined
  try {
    const parsed = JSON.parse(line) as Partial<FixVerdict>
    if (parsed.classification && CLASSIFICATIONS.has(parsed.classification))
      return { classification: parsed.classification, reason: parsed.reason ?? '' }
  } catch {
    // not JSON; fall back to the first classification word on the line
  }
  const word = /\b(fixed|flaky|out_of_scope)\b/i.exec(line)?.[1]?.toLowerCase()
  return word ? { classification: word as FixClassification, reason: '' } : undefined
}

export type CiFixDecision = 'evaluate' | 'rerun' | 'give-up' | 'retry'

/**
 * What the driver does after a fixer session. The branch state wins over the session's claim:
 * a blocked feature gives up, a verified new commit goes to the evaluator whatever the verdict
 * says, and "flaky" only earns a rerun when nothing was changed and no rerun was spent yet.
 */
export function decideCiFix(s: {
  status: Feature['status'] | 'missing'
  newCommits: number
  postCheckOk: boolean
  verdict?: FixVerdict
  rerunDone: boolean
}): CiFixDecision {
  if (s.status === 'blocked') return 'give-up'
  if (s.newCommits > 0) return s.postCheckOk ? 'evaluate' : 'retry'
  if (s.verdict?.classification === 'flaky') return s.rerunDone ? 'retry' : 'rerun'
  if (s.verdict?.classification === 'out_of_scope') return 'give-up'
  return 'retry'
}

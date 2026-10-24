/**
 * The canary rollout of a harness release (docs/how-it-works.md → Rollout safety). Each release has
 * a rollout issue in the harness repository (`rollout vX.Y.Z`, label `harness-rollout`), opened by
 * the release workflow or, when that is missing, by the first project that looks.
 *
 * - The first project loop with `update.canary` that starts a feature claims the release with a
 *   comment and becomes its canary. The earliest claim still within its time wins, so two loops
 *   racing settle on one; the loser deletes its comment.
 * - The canary edits its claim to renew it while it tests. A claim not renewed within
 *   `update.canaryHours` lapses, and the next loop may claim the release.
 * - A passed probation marks the release verified (comment, label, issue closed); other projects
 *   take only verified releases (src/update.ts → pickTarget). A quarantine closes the issue as not
 *   planned with a link to the quarantine issue (src/quarantine.ts).
 */
import { setTimeout as sleep } from 'node:timers/promises'

import { ensureLabel } from './retro'
import { sh } from './run'
import type { RolloutView } from './update'

export const ROLLOUT_LABEL = 'harness-rollout'
export const VERIFIED_LABEL = 'harness-verified'

const ROLLOUT_MARKER = 'harness-rollout'
const CLAIM_MARKER = 'harness-claim'
const VERIFIED_MARKER = 'harness-verified'

export interface IssueComment {
  url: string
  body: string
  createdAt: string
}

export interface RolloutIssue {
  number: number
  title: string
  body: string
  url: string
  labels: { name: string }[]
  comments?: IssueComment[]
}

export interface Claim {
  project: string
  until: string
  commentId: string
  createdAt: string
}

export interface RolloutState extends RolloutView {
  issue: number
  url: string
}

/** What a project needs to renew, release or settle its claim. */
export interface CanaryClaim {
  repo: string
  issue: number
  commentId: string
  version: string
  me: string
}

/** The numeric id GitHub's REST API uses for a comment, from its URL. */
export function commentId(url: string): string | undefined {
  return /#issuecomment-(\d+)$/.exec(url)?.[1]
}

function marker<T>(body: string, name: string): T | undefined {
  const raw = new RegExp(`<!-- ${name} (\\{.*?\\}) -->`).exec(body)?.[1]
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

export function rolloutVersion(issue: Pick<RolloutIssue, 'title' | 'body'>): string | undefined {
  return (
    new RegExp(`<!-- ${ROLLOUT_MARKER} v(\\d+\\.\\d+\\.\\d+) -->`).exec(issue.body)?.[1] ??
    /^rollout v(\d+\.\d+\.\d+)\b/.exec(issue.title)?.[1]
  )
}

/** A claim comment; `released` (the reason) ends it, with `until` set to the moment it ended. */
export function claimBody(
  version: string,
  project: string,
  until: string,
  released?: string,
): string {
  const text =
    released === undefined
      ? `${project} tests v${version} as canary until ${until.slice(0, 16).replace('T', ' ')} UTC.`
      : `${project} no longer tests v${version}${released ? `: ${released}` : ''}.`
  return `${text}\n\n<!-- ${CLAIM_MARKER} ${JSON.stringify({ project, until })} -->`
}

/** Verified, and the claim that holds the release now: the earliest one whose time has not run out. */
export function rolloutState(issue: RolloutIssue, now: number): RolloutState {
  const comments = issue.comments ?? []
  let verified: string | undefined
  for (const c of comments) {
    const v = marker<{ project?: string }>(c.body, VERIFIED_MARKER)
    if (v) verified = v.project ?? '?'
  }
  if (!verified && issue.labels.some((l) => l.name === VERIFIED_LABEL)) verified = '?'
  const claims = comments
    .flatMap((c): Claim[] => {
      const m = marker<{ project?: string; until?: string }>(c.body, CLAIM_MARKER)
      const id = commentId(c.url)
      if (!m?.project || !m.until || !id || Number.isNaN(Date.parse(m.until))) return []
      return [{ project: m.project, until: m.until, commentId: id, createdAt: c.createdAt }]
    })
    .filter((c) => Date.parse(c.until) > now)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  return { issue: issue.number, url: issue.url, verified, claim: claims[0] }
}

/** The state of each release with a rollout issue; the lowest-numbered issue counts for a version. */
export function rolloutStates(issues: RolloutIssue[], now: number): Map<string, RolloutState> {
  const states = new Map<string, RolloutState>()
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    const version = rolloutVersion(issue)
    if (version && !states.has(version)) states.set(version, rolloutState(issue, now))
  }
  return states
}

const ISSUE_FIELDS = 'number,title,body,url,labels,comments'

function gh(args: string[], cwd: string, what: string): string {
  const r = sh('gh', args, { cwd, quiet: true })
  if (r.code !== 0) throw new Error(`${what} failed: ${r.err || r.out}`)
  return r.out
}

function viewIssue(repo: string, issue: number, cwd: string): RolloutIssue {
  return JSON.parse(
    gh(
      ['issue', 'view', String(issue), '--repo', repo, '--json', ISSUE_FIELDS],
      cwd,
      'gh issue view',
    ),
  ) as RolloutIssue
}

export function listRollouts(repo: string, cwd: string): RolloutIssue[] {
  const issues = JSON.parse(
    gh(
      [
        'issue',
        'list',
        '--repo',
        repo,
        '--label',
        ROLLOUT_LABEL,
        '--state',
        'all',
        '--limit',
        '100',
        '--json',
        ISSUE_FIELDS,
      ],
      cwd,
      'gh issue list',
    ) || '[]',
  ) as RolloutIssue[]
  // Claims live in comments; never decide without them.
  return issues.map((i) => (Array.isArray(i.comments) ? i : viewIssue(repo, i.number, cwd)))
}

/** The rollout issue of `version`, opened now when the release workflow did not. */
export function ensureRolloutIssue(
  repo: string,
  version: string,
  cwd: string,
  known?: number,
): number {
  if (known) return known
  ensureLabel(repo, ROLLOUT_LABEL, 'The canary rollout of a harness release', cwd)
  const url = gh(
    [
      'issue',
      'create',
      '--repo',
      repo,
      '--title',
      `rollout v${version}`,
      '--label',
      ROLLOUT_LABEL,
      '--body',
      `The canary rollout of [v${version}](https://github.com/${repo}/releases/tag/v${version}). Opened by a project loop because the release had no rollout issue.\n\n<!-- ${ROLLOUT_MARKER} v${version} -->`,
    ],
    cwd,
    'gh issue create',
  )
  const number = Number(/(\d+)\s*$/.exec(url)?.[1])
  // Two projects may race here; the lowest-numbered issue counts (rolloutStates).
  const states = rolloutStates(listRollouts(repo, cwd), Date.now())
  return states.get(version)?.issue ?? number
}

const until = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()

function editComment(repo: string, id: string, body: string, cwd: string) {
  gh(
    ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${id}`, '-f', `body=${body}`],
    cwd,
    'editing a claim',
  )
}

/**
 * Claims `version` for `me`: comments, waits for GitHub to settle, and reads the issue back. Only
 * when the earliest live claim is this one does `me` become the canary; otherwise the comment is
 * deleted and the holder named.
 */
export async function claim(
  c: Omit<CanaryClaim, 'commentId'>,
  hours: number,
  cwd: string,
  settleMs = 5000,
): Promise<{ won: true; claim: CanaryClaim } | { won: false; holder?: string }> {
  const url = gh(
    [
      'issue',
      'comment',
      String(c.issue),
      '--repo',
      c.repo,
      '--body',
      claimBody(c.version, c.me, until(hours)),
    ],
    cwd,
    'gh issue comment',
  )
  const id = commentId(url.split('\n').find((l) => l.startsWith('https://')) ?? url)
  if (!id) throw new Error(`could not read the claim comment id from ${url}`)
  if (settleMs > 0) await sleep(settleMs)
  const held = rolloutState(viewIssue(c.repo, c.issue, cwd), Date.now()).claim
  if (held?.commentId === id) return { won: true, claim: { ...c, commentId: id } }
  sh('gh', ['api', '-X', 'DELETE', `repos/${c.repo}/issues/comments/${id}`], { cwd, quiet: true })
  return { won: false, holder: held?.project }
}

export function renewClaim(c: CanaryClaim, hours: number, cwd: string) {
  editComment(c.repo, c.commentId, claimBody(c.version, c.me, until(hours)), cwd)
}

/** Ends the claim now, so the next loop may test the release. */
export function releaseClaim(c: CanaryClaim, reason: string, cwd: string) {
  editComment(
    c.repo,
    c.commentId,
    claimBody(c.version, c.me, new Date().toISOString(), reason),
    cwd,
  )
}

export function markVerified(c: CanaryClaim, evidence: string[], cwd: string) {
  const body = [
    `✅ v${c.version} verified by ${c.me}; projects that are not canaries may take it now.`,
    ...evidence.map((e) => `- ${e}`),
    '',
    `<!-- ${VERIFIED_MARKER} ${JSON.stringify({ project: c.me, at: new Date().toISOString() })} -->`,
  ].join('\n')
  gh(
    ['issue', 'comment', String(c.issue), '--repo', c.repo, '--body', body],
    cwd,
    'gh issue comment',
  )
  ensureLabel(c.repo, VERIFIED_LABEL, 'A harness release a canary project verified', cwd)
  sh('gh', ['issue', 'edit', String(c.issue), '--repo', c.repo, '--add-label', VERIFIED_LABEL], {
    cwd,
    quiet: true,
  })
  sh('gh', ['issue', 'close', String(c.issue), '--repo', c.repo, '--reason', 'completed'], {
    cwd,
    quiet: true,
  })
}

export function markQuarantined(c: CanaryClaim, quarantineUrl: string, cwd: string) {
  sh(
    'gh',
    [
      'issue',
      'comment',
      String(c.issue),
      '--repo',
      c.repo,
      '--body',
      `⛔ v${c.version} is quarantined after ${c.me}'s test: ${quarantineUrl}`,
    ],
    { cwd, quiet: true },
  )
  releaseClaim(c, 'quarantined', cwd)
  sh('gh', ['issue', 'close', String(c.issue), '--repo', c.repo, '--reason', 'not planned'], {
    cwd,
    quiet: true,
  })
}

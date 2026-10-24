/**
 * Quarantining a harness release (docs/how-it-works.md → Rollout safety). An issue in the harness
 * repository labelled `harness-quarantine` names the version in its title; every project's loop
 * skips that release and moves a project that runs it to another one (src/update.ts →
 * pickTarget). The issue also carries the retro label and a feature block, so the harness
 * repository's loop builds the fix (`retro.intake`).
 *
 * Closing the issue as not planned lifts the quarantine (a false alarm). Closing it as completed,
 * which the fix PR does, keeps the bad release quarantined; the fix is a newer release.
 * A second project that finds the same release bad comments on the same issue (one fingerprint
 * per version).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { type Project } from './config'
import { ensureLabel, fingerprintOf, listIssues, MARKER, type IssueFeature } from './retro'
import { sh } from './run'
import { QUARANTINE_LABEL, rolloutRepo } from './update'

export interface QuarantineReport {
  /** The release that is held back. */
  version: string
  /** The release the project ran before it, or falls back to. */
  from: string
  /** One line: what went wrong. */
  cause: string
  evidence: string[]
}

export const quarantineFingerprint = (version: string) =>
  `quarantine-v${version.replace(/\./g, '-')}`

export function quarantineTitle(r: QuarantineReport, projectName: string): string {
  const cause = r.cause.length > 90 ? `${r.cause.slice(0, 87)}…` : r.cause
  return `quarantine v${r.version}: ${cause} (${projectName})`
}

export function quarantineBody(r: QuarantineReport, projectName: string, date: string): string {
  const feature: IssueFeature = {
    title: `Fix the regression in v${r.version} seen in ${projectName}`,
    user_visible_behavior: `${r.cause}. A release after v${r.version} no longer shows it: the evidence in this issue does not reproduce and harness selftest passes in ${projectName}.`,
    verification: ['L1: pnpm check'],
    safety: false,
  }
  return [
    `Harness v${r.version} is quarantined: project loops skip it, and a project that runs it moves to another release.`,
    '',
    `**Cause** (${projectName}, ${date}, previous release v${r.from}): ${r.cause}`,
    '',
    '**Evidence**',
    ...r.evidence.map((e) => `- ${e}`),
    '',
    'Close as **not planned** to lift the quarantine (a false alarm). The fix PR closes it as completed, which keeps this release quarantined; projects move to the fix release.',
    '',
    '```json harness-feature',
    JSON.stringify(feature, null, 2),
    '```',
    '',
    `<!-- ${MARKER} ${quarantineFingerprint(r.version)} -->`,
  ].join('\n')
}

/** Files the quarantine issue, or comments on (and if lifted, reopens) the one for this version. */
export function quarantine(
  project: Project,
  r: QuarantineReport,
): { action: 'filed' | 'commented' | 'reopened'; url: string } {
  const { config, root } = project
  const repo = rolloutRepo(config)
  const date = new Date().toISOString().slice(0, 10)
  const name = config.project.name
  const match = listIssues(repo, QUARANTINE_LABEL, 'all', root).find(
    (i) => fingerprintOf(i.body) === quarantineFingerprint(r.version),
  )
  if (match) {
    const reopen = match.state === 'CLOSED' && match.stateReason === 'NOT_PLANNED'
    if (reopen)
      sh('gh', ['issue', 'reopen', String(match.number), '--repo', repo], {
        cwd: root,
        quiet: true,
      })
    const comment = [
      `Seen in ${name} (${date}, previous release v${r.from}): ${r.cause}`,
      ...r.evidence.map((e) => `- ${e}`),
    ].join('\n')
    sh('gh', ['issue', 'comment', String(match.number), '--repo', repo, '--body', comment], {
      cwd: root,
      quiet: true,
    })
    return { action: reopen ? 'reopened' : 'commented', url: match.url }
  }
  ensureLabel(repo, QUARANTINE_LABEL, 'A harness release project loops must not take', root)
  ensureLabel(
    repo,
    config.retro.label,
    'Found by harness retro; the loop turns it into a feature',
    root,
  )
  const bodyFile = path.join(root, config.traceDir, `quarantine-v${r.version}.md`)
  mkdirSync(path.dirname(bodyFile), { recursive: true })
  writeFileSync(bodyFile, quarantineBody(r, name, date))
  const created = sh(
    'gh',
    [
      'issue',
      'create',
      '--repo',
      repo,
      '--title',
      quarantineTitle(r, name),
      '--body-file',
      bodyFile,
      '--label',
      QUARANTINE_LABEL,
      '--label',
      config.retro.label,
    ],
    { cwd: root, quiet: true },
  )
  if (created.code !== 0) throw new Error(`gh issue create --repo ${repo} failed: ${created.err}`)
  return {
    action: 'filed',
    url: created.out.split('\n').find((l) => l.startsWith('https://')) ?? created.out,
  }
}

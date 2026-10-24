import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { parseConfig, type Project } from '../src/config'

let issues: unknown[] = []
const calls: string[][] = []
vi.mock('../src/run', async (original) => ({
  ...(await original<typeof import('../src/run')>()),
  sh: (command: string, args: string[]) => {
    calls.push([command, ...args])
    if (args[0] === 'issue' && args[1] === 'list')
      return { code: 0, out: JSON.stringify(issues), err: '' }
    if (args[0] === 'issue' && args[1] === 'create')
      return { code: 0, out: 'https://github.com/Eemelinen/harness/issues/12', err: '' }
    return { code: 0, out: '', err: '' }
  },
}))

const { quarantine, quarantineBody, quarantineFingerprint, quarantineTitle } =
  await import('../src/quarantine')
const { fingerprintOf, parseIssueFeature } = await import('../src/retro')
const { quarantinedVersions } = await import('../src/update')

const report = {
  version: '0.3.5',
  from: '0.3.4',
  cause: 'harness selftest regresses: guard allows: pnpm check',
  evidence: ['`guard allows: pnpm check` passes on v0.3.4, fails on v0.3.5: blocked'],
}

function project(): Project {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-quarantine-'))
  return {
    root,
    config: parseConfig({
      project: { name: 'Metsävahti' },
      generator: { model: 'm' },
      evaluator: { model: 'm' },
    }),
    resolve: (...s) => path.resolve(root, ...s),
  }
}

describe('quarantine issue', () => {
  it('has a title the rollout reads back and a feature block the harness loop builds', () => {
    const title = quarantineTitle(report, 'Metsävahti')
    expect(title).toBe(
      'quarantine v0.3.5: harness selftest regresses: guard allows: pnpm check (Metsävahti)',
    )
    expect([...quarantinedVersions([{ title, state: 'OPEN' }])]).toEqual(['0.3.5'])
    const body = quarantineBody(report, 'Metsävahti', '2026-10-25')
    expect(fingerprintOf(body)).toBe('quarantine-v0-3-5')
    expect(parseIssueFeature(body)).toEqual({
      title: 'Fix the regression in v0.3.5 seen in Metsävahti',
      user_visible_behavior: expect.stringContaining('A release after v0.3.5 no longer shows it'),
      verification: ['L1: pnpm check'],
      safety: false,
    })
    expect(body).toContain(report.evidence[0])
  })

  it('keeps a long cause on one readable title line', () => {
    const title = quarantineTitle({ ...report, cause: 'x'.repeat(200) }, 'P')
    expect(title.length).toBeLessThan(130)
    expect(title).toMatch(/…$|… \(P\)$/)
  })
})

describe('quarantine', () => {
  beforeEach(() => {
    calls.length = 0
    issues = []
  })

  it('files a new issue with the quarantine and retro labels', () => {
    expect(quarantine(project(), report)).toEqual({
      action: 'filed',
      url: 'https://github.com/Eemelinen/harness/issues/12',
    })
    const create = calls.find((c) => c[1] === 'issue' && c[2] === 'create')!
    expect(create).toEqual(
      expect.arrayContaining([
        '--repo',
        'Eemelinen/harness',
        '--label',
        'harness-quarantine',
        'harness-retro',
      ]),
    )
  })

  it('comments on the issue another project filed for the same release', () => {
    issues = [
      {
        number: 7,
        title: 'quarantine v0.3.5: x (Ideaforge)',
        state: 'OPEN',
        body: `x\n<!-- harness-retro fingerprint: ${quarantineFingerprint('0.3.5')} -->`,
        url: 'u7',
        labels: [],
      },
    ]
    expect(quarantine(project(), report)).toEqual({ action: 'commented', url: 'u7' })
    expect(calls.some((c) => c[2] === 'create')).toBe(false)
    expect(calls.find((c) => c[2] === 'comment')).toEqual(expect.arrayContaining(['7']))
  })

  it('reopens a lifted quarantine when the release fails again', () => {
    issues = [
      {
        number: 8,
        title: 'quarantine v0.3.5: x',
        state: 'CLOSED',
        stateReason: 'NOT_PLANNED',
        body: `<!-- harness-retro fingerprint: ${quarantineFingerprint('0.3.5')} -->`,
        url: 'u8',
        labels: [],
      },
    ]
    expect(quarantine(project(), report)).toEqual({ action: 'reopened', url: 'u8' })
    expect(calls.find((c) => c[2] === 'reopen')).toEqual(expect.arrayContaining(['8']))
  })
})

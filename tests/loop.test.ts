import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  asideBranch,
  mergeResult,
  pinBranch,
  pluginDir,
  queueEmptyNotice,
  probationResult,
  readCarry,
  retryFeature,
  supervise,
  withHarnessVersion,
} from '../src/loop'

function dir(name: string, pkg: object) {
  const root = mkdtempSync(path.join(tmpdir(), `harness-${name}-`))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
  return root
}

describe('pluginDir', () => {
  const driver = '/driver/checkout'

  it('uses the harness version installed in the project', () => {
    const project = dir('project', { name: 'project' })
    const installed = path.join(project, 'node_modules', '@eemelinen', 'harness')
    mkdirSync(installed, { recursive: true })
    writeFileSync(
      path.join(installed, 'package.json'),
      JSON.stringify({ name: '@eemelinen/harness' }),
    )
    expect(pluginDir(project, driver)).toBe(path.join(installed, 'plugin'))
  })

  it('never gives a harness worktree its own plugin', () => {
    const harness = dir('self', {
      name: '@eemelinen/harness',
      exports: { './package.json': './package.json' },
    })
    expect(pluginDir(harness, driver)).toBe(path.join(driver, 'plugin'))
  })

  it('falls back to the driver when nothing is installed', () => {
    expect(pluginDir(dir('bare', { name: 'bare' }), driver)).toBe(path.join(driver, 'plugin'))
  })
})

describe('mergeResult', () => {
  it('sums the turns of a session resumed by a wakeup and keeps the session totals', () => {
    // personal-finances F-015 attempt 1: three segments, recorded as 2 turns before the fix.
    const segments = [
      { type: 'result', num_turns: 87, total_cost_usd: 9.39, subtype: 'success' },
      { type: 'result', num_turns: 18, total_cost_usd: 9.39, subtype: 'success' },
      { type: 'result', num_turns: 2, total_cost_usd: 9.52, subtype: 'success' },
    ]
    const merged = segments.reduce<Record<string, unknown> | undefined>(mergeResult, undefined)
    expect(merged).toEqual({
      type: 'result',
      num_turns: 107,
      total_cost_usd: 9.52,
      subtype: 'success',
    })
  })

  it('passes a single result through unchanged', () => {
    const only = { type: 'result', num_turns: 40, total_cost_usd: 3 }
    expect(mergeResult(undefined, only)).toBe(only)
  })
})

describe('queueEmptyNotice', () => {
  const list = {
    features: [
      { id: 'F-002', status: 'passing' as const },
      { id: 'F-015', status: 'not_started' as const },
    ],
  }

  it('names a merged leftover branch separately from work in flight', () => {
    // personal-finances: feat/F-002 survived its merge, feat/F-015 holds a blocked attempt.
    expect(queueEmptyNotice(['F-002', 'F-015'], list, 'feat/')).toBe(
      'queue empty (F-015 in flight — merge their PRs to unblock dependents); leftover branches of passing features, safe to delete: feat/F-002',
    )
  })

  it('says only that the queue is empty when no branch is left', () => {
    expect(queueEmptyNotice([], list, 'feat/')).toBe('queue empty')
  })
})

describe('pinBranch', () => {
  it('names forward and backward pin moves apart', () => {
    expect(pinBranch('0.3.2', true)).toBe('harness/update-v0.3.2')
    expect(pinBranch('0.3.0', false)).toBe('harness/rollback-v0.3.0')
  })
})

describe('readCarry', () => {
  it('restores what a restarted loop run keeps', () => {
    const carry = {
      attempted: ['F-001'],
      intakeIssues: [5],
      retros: 1,
      consecutiveFailures: 1,
      updates: ['0.3.1'],
    }
    expect(readCarry(JSON.stringify(carry))).toEqual(carry)
  })

  it('starts empty without or with a broken carry', () => {
    const empty = {
      attempted: [],
      intakeIssues: [],
      retros: 0,
      consecutiveFailures: 0,
      updates: [],
    }
    expect(readCarry(undefined)).toEqual(empty)
    expect(readCarry('{')).toEqual(empty)
    expect(readCarry('{"retros":2}')).toEqual({ ...empty, retros: 2 })
  })
})

describe('withHarnessVersion', () => {
  it('stamps a run record with the harness version unless it has one', () => {
    expect(withHarnessVersion({ feature: 'F-001' }, '0.3.1')).toEqual({
      feature: 'F-001',
      harness: '0.3.1',
    })
    expect(withHarnessVersion({ feature: 'F-001', harness: '0.3.0' }, '0.3.1').harness).toBe(
      '0.3.0',
    )
  })
})

describe('probation', () => {
  it('keeps a release whose first feature is done and suspects it otherwise', () => {
    expect(probationResult('done')).toBe('passed')
    expect(probationResult('failed')).toBe('suspect')
    expect(probationResult('blocked')).toBe('suspect')
    expect(probationResult('error')).toBe('suspect')
    expect(probationResult('aborted')).toBe('pending')
  })

  it('keeps the run of a suspect release apart from the feature branch', () => {
    expect(asideBranch('0.3.5', 'F-012')).toBe('harness/probation-v0.3.5-F-012')
  })

  it('carries probation and the re-test across a restart', () => {
    const carry = {
      attempted: [],
      intakeIssues: [],
      retros: 0,
      consecutiveFailures: 0,
      updates: ['0.3.5'],
      probation: {
        version: '0.3.5',
        from: '0.3.4',
        canary: { repo: 'o/harness', issue: 4, commentId: '99', version: '0.3.5', me: 'o/p' },
      },
      retry: { feature: 'F-012', suspect: '0.3.5', from: '0.3.4', evidence: ['F-012: failed'] },
    }
    expect(readCarry(JSON.stringify(carry))).toEqual(carry)
  })
})

describe('supervise', () => {
  const probation = { version: '0.3.5', from: '0.3.4' }

  it('rolls back when the restarted driver errors before its probation settles', () => {
    expect(supervise({ code: 1, aborted: false, probation, records: [] })).toBe('rollback')
    expect(
      supervise({ code: 1, aborted: false, probation, records: [{ outcome: 'failed' }] }),
    ).toBe('rollback')
  })

  it('leaves a clean exit, an abort, a settled probation and no probation alone', () => {
    expect(supervise({ code: 0, aborted: false, probation, records: [] })).toBe('exit')
    expect(supervise({ code: 130, aborted: true, probation, records: [] })).toBe('exit')
    for (const outcome of [
      'probation-ok',
      'rolled-back',
      'quarantined',
      'probation-cleared',
      'restart-mismatch',
    ])
      expect(supervise({ code: 1, aborted: false, probation, records: [{ outcome }] })).toBe('exit')
    expect(supervise({ code: 1, aborted: false, records: [] })).toBe('exit')
  })
})

describe('retryFeature', () => {
  const feature = (id: string) =>
    ({ id, title: id, depends_on: [], status: 'not_started' }) as unknown as Parameters<
      typeof retryFeature
    >[1]['features'][number]
  const retry = { feature: 'F-012', suspect: '0.3.5', from: '0.3.4', evidence: [] }

  it('re-tests the feature from the list, or the retro feature it came from', () => {
    const list = { features: [feature('F-011'), feature('F-012')] }
    expect(retryFeature(retry, list)?.id).toBe('F-012')
    const intake = { issue: 5, url: 'u', repo: 'r', feature: feature('F-020'), safety: false }
    expect(retryFeature({ ...retry, feature: 'F-020', intake }, list)?.id).toBe('F-020')
  })

  it('has nothing to re-test without a retry or once the feature is gone', () => {
    expect(retryFeature(undefined, { features: [feature('F-012')] })).toBeUndefined()
    expect(retryFeature(retry, { features: [feature('F-011')] })).toBeUndefined()
  })
})

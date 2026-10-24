import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { mergeResult, pluginDir, queueEmptyNotice } from '../src/loop'

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

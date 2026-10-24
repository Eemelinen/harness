import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { parseConfig, type Project } from '../src/config'

const issues = [
  {
    number: 3,
    title: 'retro: queued one',
    state: 'OPEN',
    body: 'x',
    url: 'u3',
    labels: [{ name: 'harness-retro:queued' }],
  },
  { number: 9, title: 'retro: no block', state: 'OPEN', body: 'plain text', url: 'u9', labels: [] },
  {
    number: 5,
    title: 'retro: skip heredoc data',
    state: 'OPEN',
    url: 'https://github.com/o/harness/issues/5',
    labels: [{ name: 'harness-retro' }],
    body: [
      'The guard matched a heredoc.',
      '',
      '```json harness-feature',
      JSON.stringify({
        title: 'Skip heredoc data',
        user_visible_behavior: 'Drop bodies.',
        verification: ['L1: pnpm check'],
        safety: true,
      }),
      '```',
    ].join('\n'),
  },
]

const calls: string[][] = []
vi.mock('../src/run', async (original) => ({
  ...(await original<typeof import('../src/run')>()),
  sh: (command: string, args: string[]) => {
    calls.push([command, ...args])
    if (command === 'git') return { code: 0, out: 'git@github.com:o/harness.git', err: '' }
    return { code: 0, out: JSON.stringify(issues), err: '' }
  },
}))

const { nextIntake } = await import('../src/retro')

describe('retro intake', () => {
  it('turns the oldest unqueued issue with a feature block into the next feature', () => {
    const project: Project = {
      root: '/p',
      config: parseConfig({ generator: { model: 'm' }, evaluator: { model: 'm' } }),
      resolve: (...s) => path.resolve('/p', ...s),
    }
    const item = nextIntake(project, ['F-000', 'F-004'], 7)
    expect(calls.find((c) => c[0] === 'gh')).toEqual(
      expect.arrayContaining([
        'issue',
        'list',
        '--repo',
        'o/harness',
        '--label',
        'harness-retro',
        '--state',
        'open',
      ]),
    )
    expect(item).toMatchObject({ issue: 5, repo: 'o/harness', safety: true })
    expect(item?.feature).toMatchObject({
      id: 'F-005',
      priority: 8,
      title: 'Skip heredoc data',
      user_visible_behavior: 'Drop bodies.',
      status: 'not_started',
      verification: ['L1: pnpm check'],
    })
    expect(item?.feature.notes).toBe(
      'From retro issue o/harness#5: https://github.com/o/harness/issues/5\n\nThe guard matched a heredoc.',
    )
  })

  it('takes only issues with the intake label when one is set', () => {
    const gated = (labels: string[]) => {
      issues[2]!.labels = labels.map((name) => ({ name }))
      const project: Project = {
        root: '/p',
        config: parseConfig({
          generator: { model: 'm' },
          evaluator: { model: 'm' },
          retro: { intakeLabel: 'updater:accepted' },
        }),
        resolve: (...s) => path.resolve('/p', ...s),
      }
      return nextIntake(project, ['F-000'], 0)
    }
    expect(gated(['harness-retro'])).toBeUndefined()
    expect(gated(['harness-retro', 'updater:accepted'])?.issue).toBe(5)
  })
})

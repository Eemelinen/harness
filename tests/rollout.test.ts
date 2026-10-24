import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The rollout issue `gh issue view` returns; tests put the competing claims in it. */
let comments: { url: string; body: string; createdAt: string }[] = []
const calls: string[][] = []
vi.mock('../src/run', async (original) => ({
  ...(await original<typeof import('../src/run')>()),
  sh: (command: string, args: string[]) => {
    calls.push([command, ...args])
    if (args[0] === 'issue' && args[1] === 'comment') {
      const body = args[args.indexOf('--body') + 1]!
      const url = `https://github.com/o/harness/issues/4#issuecomment-${200 + comments.length}`
      comments.push({ url, body, createdAt: new Date().toISOString() })
      return { code: 0, out: url, err: '' }
    }
    if (args[0] === 'issue' && args[1] === 'view')
      return {
        code: 0,
        out: JSON.stringify({
          number: 4,
          title: 'rollout v0.3.5',
          body: '',
          url: 'u',
          labels: [],
          comments,
        }),
        err: '',
      }
    return { code: 0, out: '', err: '' }
  },
}))

const { claim, claimBody, commentId, rolloutState, rolloutStates, rolloutVersion } =
  await import('../src/rollout')

const hour = 3_600_000
const now = Date.parse('2026-10-25T12:00:00Z')
const at = (offsetHours: number) => new Date(now + offsetHours * hour).toISOString()
const comment = (id: number, body: string, createdHoursAgo: number) => ({
  url: `https://github.com/o/harness/issues/4#issuecomment-${id}`,
  body,
  createdAt: at(-createdHoursAgo),
})
const issue = (extra: object = {}) => ({
  number: 4,
  title: 'rollout v0.3.5',
  body: 'notes\n\n<!-- harness-rollout v0.3.5 -->',
  url: 'https://github.com/o/harness/issues/4',
  labels: [],
  comments: [],
  ...extra,
})

describe('rollout markers', () => {
  it('reads the version, the comment id and a claim back', () => {
    expect(rolloutVersion(issue())).toBe('0.3.5')
    expect(rolloutVersion({ title: 'rollout v0.3.6', body: '' })).toBe('0.3.6')
    expect(commentId('https://github.com/o/r/issues/4#issuecomment-123')).toBe('123')
    const state = rolloutState(
      issue({ comments: [comment(7, claimBody('0.3.5', 'o/p', at(2)), 1)] }),
      now,
    )
    expect(state.claim).toEqual({
      project: 'o/p',
      until: at(2),
      commentId: '7',
      createdAt: at(-1),
    })
  })
})

describe('rolloutState', () => {
  it('lets the earliest live claim hold the release', () => {
    const state = rolloutState(
      issue({
        comments: [
          comment(5, claimBody('0.3.5', 'o/old', at(-1)), 6),
          comment(6, claimBody('0.3.5', 'o/first', at(3)), 2),
          comment(7, claimBody('0.3.5', 'o/second', at(4)), 1),
        ],
      }),
      now,
    )
    expect(state.claim?.project).toBe('o/first')
  })

  it('keeps a renewed claim in its place and drops a released or broken one', () => {
    const renewed = comment(6, claimBody('0.3.5', 'o/first', at(4)), 5)
    const later = comment(7, claimBody('0.3.5', 'o/second', at(4)), 1)
    expect(rolloutState(issue({ comments: [renewed, later] }), now).claim?.project).toBe('o/first')
    const released = comment(6, claimBody('0.3.5', 'o/first', at(-0.1), 'quarantined'), 5)
    expect(released.body).toContain('no longer tests v0.3.5: quarantined')
    const broken = comment(8, '<!-- harness-claim {"project": -->', 0.5)
    expect(rolloutState(issue({ comments: [released, broken, later] }), now).claim?.project).toBe(
      'o/second',
    )
  })

  it('reads the verifying project from its marker, or the label alone', () => {
    const v = comment(9, '✅\n<!-- harness-verified {"project":"o/p","at":"x"} -->', 0.5)
    expect(rolloutState(issue({ comments: [v] }), now).verified).toBe('o/p')
    expect(rolloutState(issue({ labels: [{ name: 'harness-verified' }] }), now).verified).toBe('?')
    expect(rolloutState(issue(), now).verified).toBeUndefined()
  })

  it('counts the lowest-numbered issue when two exist for a release', () => {
    const states = rolloutStates(
      [
        issue({ number: 9, labels: [{ name: 'harness-verified' }] }),
        issue({ number: 4 }),
        issue({ number: 10, title: 'rollout v0.3.6', body: '' }),
      ],
      now,
    )
    expect(states.get('0.3.5')).toMatchObject({ issue: 4, verified: undefined })
    expect(states.get('0.3.6')?.issue).toBe(10)
  })
})

describe('claim', () => {
  const who = { repo: 'o/harness', issue: 4, version: '0.3.5', me: 'o/me' }

  beforeEach(() => {
    comments = []
    calls.length = 0
  })

  it('wins when nobody else holds the release', async () => {
    const result = await claim(who, 4, '/p', 0)
    expect(result).toEqual({ won: true, claim: { ...who, commentId: '200' } })
    expect(comments[0]!.body).toContain('o/me tests v0.3.5 as canary until')
  })

  it('loses to an earlier live claim and deletes its own comment', async () => {
    comments = [
      {
        url: 'https://github.com/o/harness/issues/4#issuecomment-150',
        body: claimBody('0.3.5', 'o/other', new Date(Date.now() + hour).toISOString()),
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ]
    expect(await claim(who, 4, '/p', 0)).toEqual({ won: false, holder: 'o/other' })
    expect(calls.find((c) => c.includes('DELETE'))).toEqual(
      expect.arrayContaining(['repos/o/harness/issues/comments/201']),
    )
  })

  it('takes over a claim that lapsed', async () => {
    comments = [
      {
        url: 'https://github.com/o/harness/issues/4#issuecomment-150',
        body: claimBody('0.3.5', 'o/other', new Date(Date.now() - 60_000).toISOString()),
        createdAt: new Date(Date.now() - 5 * hour).toISOString(),
      },
    ]
    expect(await claim(who, 4, '/p', 0)).toMatchObject({ won: true })
  })
})

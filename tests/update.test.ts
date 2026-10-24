import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  compareVersions,
  isBreaking,
  isHarnessRepo,
  latestRelease,
  newestTag,
  notPinOnly,
  pickTarget,
  pinSpec,
  quarantinedVersions,
  repositoryUrl,
  type RolloutView,
  withMarketplaceRef,
} from '../src/update'

describe('versions', () => {
  it('compares numerically, with or without the v', () => {
    expect(['0.10.0', '0.3.1', 'v0.3.0', '1.0.0'].sort(compareVersions)).toEqual([
      'v0.3.0',
      '0.3.1',
      '0.10.0',
      '1.0.0',
    ])
  })

  it('calls a new major version, or a new minor version while 0.x, breaking', () => {
    expect(isBreaking('0.3.0', '0.3.9')).toBe(false)
    expect(isBreaking('0.3.0', '0.4.0')).toBe(true)
    expect(isBreaking('1.2.0', '1.5.3')).toBe(false)
    expect(isBreaking('1.2.0', '2.0.0')).toBe(true)
  })

  it('finds the newest vX.Y.Z tag and ignores other tags', () => {
    const out = [
      'a\trefs/tags/v0.2.0',
      'b\trefs/tags/v0.10.1',
      'c\trefs/tags/v0.9.0',
      'd\trefs/tags/v1.0.0-rc.1',
      'e\trefs/tags/0.99.0',
    ].join('\n')
    expect(newestTag(out)).toBe('0.10.1')
    expect(newestTag('')).toBeUndefined()
  })
})

describe('latestRelease', () => {
  it('reads the tags of a git remote', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'harness-tags-'))
    const git = (...args: string[]) => {
      const r = spawnSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: repo, encoding: 'utf8' },
      )
      if (r.status !== 0) throw new Error(r.stderr)
    }
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'init')
    for (const tag of ['v0.3.0', 'v0.3.2', 'v0.3.10', 'nightly']) git('tag', tag)
    expect(latestRelease(repo, tmpdir())).toBe('0.3.10')
  })
})

describe('the installed package', () => {
  it('knows its repository and the pin spec', () => {
    expect(repositoryUrl()).toBe('https://github.com/Eemelinen/harness.git')
    expect(pinSpec('0.3.1')).toBe('github:Eemelinen/harness#v0.3.1')
  })

  it('recognises the harness repository', () => {
    expect(isHarnessRepo(path.resolve(import.meta.dirname, '..'))).toBe(true)
    const other = mkdtempSync(path.join(tmpdir(), 'harness-other-'))
    writeFileSync(path.join(other, 'package.json'), '{"name":"project"}')
    expect(isHarnessRepo(other)).toBe(false)
    expect(isHarnessRepo(path.join(other, 'missing'))).toBe(false)
  })
})

const settingsText = `{
  "permissions": { "allow": ["Bash(pnpm check)"] },
  "extraKnownMarketplaces": {
    "eemelinen-harness": {
      "source": {
        "source": "github",
        "repo": "Eemelinen/harness",
        "ref": "v0.3.0"
      }
    }
  },
  "enabledPlugins": { "harness@eemelinen-harness": true }
}
`

describe('withMarketplaceRef', () => {
  it('changes only the ref and keeps the formatting', () => {
    expect(withMarketplaceRef(settingsText, '0.3.1')).toBe(
      settingsText.replace('"ref": "v0.3.0"', '"ref": "v0.3.1"'),
    )
  })

  it('leaves settings without a harness ref alone', () => {
    expect(withMarketplaceRef('{"permissions":{}}', '0.3.1')).toBeUndefined()
  })

  it('refuses to guess when the same ref appears twice', () => {
    const twice = settingsText.replace(
      '"enabledPlugins"',
      '"other": { "ref": "v0.3.0" },\n  "enabledPlugins"',
    )
    expect(() => withMarketplaceRef(twice, '0.3.1')).toThrow(/2 "ref": "v0.3.0" entries/)
  })
})

describe('notPinOnly', () => {
  const pkg = (pin: string, extra: object = {}) => ({
    name: 'p',
    scripts: { check: 'pnpm test' },
    devDependencies: { '@eemelinen/harness': pin, prettier: '3.0.0', ...extra },
  })
  const settings = (ref: string, extra: object = {}) => ({
    ...JSON.parse(settingsText),
    extraKnownMarketplaces: {
      'eemelinen-harness': { source: { source: 'github', repo: 'Eemelinen/harness', ref } },
    },
    ...extra,
  })
  const before = { packageJson: pkg(pinSpec('0.3.0')), settings: settings('v0.3.0') }
  const files = ['package.json', 'pnpm-lock.yaml', '.claude/settings.json']

  it('accepts a diff that moves only the pins', () => {
    const after = { packageJson: pkg(pinSpec('0.3.1')), settings: settings('v0.3.1') }
    expect(notPinOnly(files, before, after)).toEqual([])
    expect(
      notPinOnly(['package.json'], before, { ...before, packageJson: after.packageJson }),
    ).toEqual([])
  })

  it('names every other change', () => {
    const after = {
      packageJson: pkg(pinSpec('0.3.1'), { vitest: '5.0.0' }),
      settings: settings('v0.3.1', { permissions: { allow: ['Bash'] } }),
    }
    expect(notPinOnly([...files, 'init.sh'], before, after)).toEqual([
      'changes init.sh',
      'package.json changes more than the @eemelinen/harness specifier',
      '.claude/settings.json changes more than the eemelinen-harness ref',
    ])
  })
})

describe('quarantinedVersions', () => {
  it('reads versions from open and completed issues, not from not-planned ones', () => {
    expect([
      ...quarantinedVersions([
        { title: 'quarantine v0.3.5: guard blocks pnpm check (metsavahti)', state: 'OPEN' },
        { title: 'quarantine v0.3.6: x', state: 'CLOSED', stateReason: 'COMPLETED' },
        { title: 'quarantine v0.3.7: false alarm', state: 'CLOSED', stateReason: 'NOT_PLANNED' },
        { title: 'quarantine v0.3.8 and v0.3.9', state: 'OPEN' },
      ]),
    ]).toEqual(['0.3.5', '0.3.6', '0.3.8', '0.3.9'])
  })
})

describe('pickTarget', () => {
  const release = (version: string, extra: object = {}) => ({
    version,
    publishedAt: '2026-10-25T10:00:00Z',
    draft: false,
    prerelease: false,
    ...extra,
  })
  const until = '2026-10-25T14:00:00.000Z'
  const verified = (project = 'o/metsavahti') => ({ verified: project })
  const claimed = (project: string) => ({ claim: { project, until, commentId: '99' } })
  const base = {
    installed: '0.3.1',
    quarantined: new Set<string>(),
    rollouts: new Map(),
    me: 'o/idea-generator',
    canary: true,
    allowBreaking: false,
  }

  it('takes the newest release a canary verified', () => {
    const releases = [release('0.3.2'), release('0.3.3')]
    const rollouts = new Map([
      ['0.3.2', verified()],
      ['0.3.3', verified()],
    ])
    expect(pickTarget({ ...base, releases, rollouts })).toEqual({
      action: 'update',
      version: '0.3.3',
      why: 'verified by o/metsavahti',
    })
  })

  it('claims an untested release nobody holds, as canary', () => {
    expect(pickTarget({ ...base, releases: [release('0.3.2')] })).toEqual({
      action: 'canary',
      version: '0.3.2',
      why: 'nobody has tested v0.3.2 yet',
    })
  })

  it('waits while another project tests it, or takes an older verified release meanwhile', () => {
    const rollouts = new Map<string, RolloutView>([['0.3.3', claimed('o/metsavahti')]])
    expect(pickTarget({ ...base, releases: [release('0.3.3')], rollouts })).toEqual({
      action: 'none',
      reason: 'v0.3.3 is being tested by o/metsavahti until 14:00 UTC',
    })
    rollouts.set('0.3.2', verified('o/personal-finances'))
    expect(
      pickTarget({ ...base, releases: [release('0.3.2'), release('0.3.3')], rollouts }),
    ).toEqual({ action: 'update', version: '0.3.2', why: 'verified by o/personal-finances' })
  })

  it('continues its own claim after a restart', () => {
    const rollouts = new Map([['0.3.2', claimed('o/idea-generator')]])
    expect(pickTarget({ ...base, releases: [release('0.3.2')], rollouts })).toMatchObject({
      action: 'canary',
      version: '0.3.2',
      resume: '99',
    })
  })

  it('takes only verified releases with update.canary off', () => {
    const releases = [release('0.3.2'), release('0.3.3')]
    expect(pickTarget({ ...base, canary: false, releases })).toEqual({
      action: 'none',
      reason: 'v0.3.3 waits for a canary project to verify it (update.canary is off here)',
    })
    const rollouts = new Map([['0.3.2', verified()]])
    expect(pickTarget({ ...base, canary: false, releases, rollouts })).toMatchObject({
      action: 'update',
      version: '0.3.2',
    })
  })

  it('skips quarantined releases, drafts and prereleases', () => {
    const releases = [
      release('0.3.2'),
      release('0.3.3'),
      release('0.3.4', { draft: true }),
      release('0.3.5', { prerelease: true }),
    ]
    expect(pickTarget({ ...base, releases, quarantined: new Set(['0.3.3']) })).toMatchObject({
      action: 'canary',
      version: '0.3.2',
    })
  })

  it('does nothing when up to date', () => {
    expect(pickTarget({ ...base, releases: [release('0.3.1')] })).toEqual({ action: 'none' })
  })

  it('reports a breaking release instead of taking it, unless allowed', () => {
    const releases = [release('0.4.0')]
    expect(pickTarget({ ...base, releases })).toMatchObject({
      action: 'notify',
      version: '0.4.0',
      reason: expect.stringContaining('update.allowBreaking'),
    })
    expect(pickTarget({ ...base, releases, allowBreaking: true })).toMatchObject({
      action: 'canary',
      version: '0.4.0',
    })
  })

  it('moves off a quarantined installed release to a verified fix', () => {
    const releases = [release('0.3.0'), release('0.3.1'), release('0.3.2')]
    const quarantined = new Set(['0.3.1'])
    expect(
      pickTarget({ ...base, releases, quarantined, rollouts: new Map([['0.3.2', verified()]]) }),
    ).toEqual({
      action: 'update',
      version: '0.3.2',
      why: 'v0.3.1 is quarantined; v0.3.2 verified by o/metsavahti',
    })
  })

  it('moves back when no fix is verified yet', () => {
    const releases = [release('0.2.9'), release('0.3.0'), release('0.3.1'), release('0.3.2')]
    expect(pickTarget({ ...base, releases, quarantined: new Set(['0.3.1']) })).toEqual({
      action: 'update',
      version: '0.3.0',
      why: 'v0.3.1 is quarantined',
    })
    expect(
      pickTarget({ ...base, releases, quarantined: new Set(['0.3.0', '0.3.1']) }),
    ).toMatchObject({ version: '0.2.9' })
  })

  it('asks for a human when a quarantined installed release has nowhere to go', () => {
    expect(
      pickTarget({ ...base, releases: [release('0.3.1')], quarantined: new Set(['0.3.1']) }),
    ).toMatchObject({ action: 'notify', version: '0.3.1' })
  })
})

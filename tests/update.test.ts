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
  const now = Date.parse('2026-10-25T12:00:00Z')
  const release = (version: string, hoursAgo: number, extra: object = {}) => ({
    version,
    publishedAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
    draft: false,
    prerelease: false,
    ...extra,
  })
  const base = {
    installed: '0.3.1',
    quarantined: new Set<string>(),
    now,
    minAgeHours: 6,
    allowBreaking: false,
  }

  it('takes the newest release that is old enough', () => {
    const releases = [release('0.3.1', 50), release('0.3.2', 30), release('0.3.3', 7)]
    expect(pickTarget({ ...base, releases })).toEqual({
      action: 'update',
      version: '0.3.3',
      why: 'newer release',
    })
  })

  it('waits for a release that is too new, and takes it at once with minAgeHours 0', () => {
    const releases = [release('0.3.2', 2)]
    expect(pickTarget({ ...base, releases })).toEqual({
      action: 'none',
      reason: 'v0.3.2 is 2.0 h old; waiting until it is 6 h old (update.minAgeHours)',
    })
    expect(pickTarget({ ...base, releases, minAgeHours: 0 })).toMatchObject({ version: '0.3.2' })
  })

  it('takes an older ready release while the newest one is still too new', () => {
    const releases = [release('0.3.2', 10), release('0.3.3', 1)]
    expect(pickTarget({ ...base, releases })).toMatchObject({ action: 'update', version: '0.3.2' })
  })

  it('skips quarantined releases, drafts and prereleases', () => {
    const releases = [
      release('0.3.2', 20),
      release('0.3.3', 20),
      release('0.3.4', 20, { draft: true }),
      release('0.3.5', 20, { prerelease: true }),
    ]
    expect(pickTarget({ ...base, releases, quarantined: new Set(['0.3.3']) })).toMatchObject({
      version: '0.3.2',
    })
  })

  it('does nothing when up to date', () => {
    expect(pickTarget({ ...base, releases: [release('0.3.1', 50)] })).toEqual({ action: 'none' })
  })

  it('reports a breaking release instead of taking it, unless allowed', () => {
    const releases = [release('0.4.0', 20)]
    expect(pickTarget({ ...base, releases })).toMatchObject({
      action: 'notify',
      version: '0.4.0',
      reason: expect.stringContaining('update.allowBreaking'),
    })
    expect(pickTarget({ ...base, releases, allowBreaking: true })).toMatchObject({
      action: 'update',
      version: '0.4.0',
    })
    expect(
      pickTarget({ ...base, releases: [release('0.3.2', 20), release('0.4.0', 20)] }),
    ).toMatchObject({ action: 'update', version: '0.3.2' })
  })

  it('moves off a quarantined installed release: forward to the fix, at any age', () => {
    const releases = [release('0.3.0', 90), release('0.3.1', 50), release('0.3.2', 1)]
    expect(pickTarget({ ...base, releases, quarantined: new Set(['0.3.1']) })).toEqual({
      action: 'update',
      version: '0.3.2',
      why: 'v0.3.1 is quarantined',
    })
  })

  it('moves back when there is no fix yet', () => {
    const releases = [release('0.2.9', 200), release('0.3.0', 90), release('0.3.1', 50)]
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
      pickTarget({ ...base, releases: [release('0.3.1', 50)], quarantined: new Set(['0.3.1']) }),
    ).toMatchObject({ action: 'notify', version: '0.3.1' })
  })
})

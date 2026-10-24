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
  pinSpec,
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

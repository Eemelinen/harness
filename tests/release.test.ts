import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  breakingSchemaChanges,
  changelogEntry,
  insertEntry,
  nextVersion,
  release,
  releasableChanges,
  type Commit,
} from '../scripts/release'

const commit = (subject: string, body = ''): Commit => ({ sha: 'x', subject, body })

describe('nextVersion', () => {
  it('bumps the patch number for any change, feat included', () => {
    expect(nextVersion('0.3.0', [commit('feat(F-004): release on merge (#7)')])).toBe('0.3.1')
    expect(nextVersion('1.2.3', [commit('fix: x'), commit('not conventional')])).toBe('1.2.4')
  })

  it('bumps the minor number for a breaking change while 0.x, the major number after', () => {
    expect(nextVersion('0.3.4', [commit('fix: a'), commit('feat!: drop a key')])).toBe('0.4.0')
    expect(nextVersion('0.3.4', [commit('fix: b', 'BREAKING CHANGE: renamed x')])).toBe('0.4.0')
    expect(nextVersion('1.2.3', [commit('refactor(config)!: rename')])).toBe('2.0.0')
  })

  it('bumps the minor number for a schema break while 0.x', () => {
    expect(nextVersion('0.3.4', [commit('feat(F-009): x')], ['removes `a`'])).toBe('0.4.0')
  })

  it('rejects a version it cannot bump', () => {
    expect(() => nextVersion('1.0.0-rc.1', [])).toThrow(/not X.Y.Z/)
  })
})

describe('breakingSchemaChanges', () => {
  const schema = (extra: object = {}) => ({
    type: 'object',
    properties: {
      merge: { default: 'wait', type: 'string', enum: ['wait', 'auto', 'none'] },
      update: {
        default: {},
        type: 'object',
        properties: { auto: { default: false, type: 'boolean' } },
      },
      generator: {
        type: 'object',
        properties: { model: { type: 'string' } },
        required: ['model'],
      },
      services: {
        anyOf: [{ type: 'object', properties: { up: { type: 'string' } } }, { type: 'null' }],
      },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      ...extra,
    },
  })

  it('finds nothing in an additive change', () => {
    expect(
      breakingSchemaChanges(schema(), schema({ added: { type: 'string', default: 'x' } })),
    ).toEqual([])
  })

  it('names removed keys, new required keys, changed defaults and narrowed enums', () => {
    const after = schema()
    const props = after.properties as Record<string, Record<string, unknown>>
    delete (props.update!.properties as Record<string, unknown>).auto
    props.generator!.required = ['model', 'effort']
    props.merge = { default: 'auto', type: 'string', enum: ['wait', 'auto'] }
    props.services = { type: 'null' }
    props.tags = { type: 'array', items: { type: 'string', enum: ['a'] } }
    expect(breakingSchemaChanges(schema(), after)).toEqual([
      'changes the default of `merge` from "wait" to "auto"',
      'removes "none" from `merge`',
      'removes `update.auto`',
      'requires `generator.effort`',
      'removes `services.up`',
      'removes "b" from `tags[]`',
    ])
  })

  it('finds no break between the committed schema and itself', () => {
    const committed = JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname, '../schema/harness.config.schema.json'),
        'utf8',
      ),
    )
    expect(breakingSchemaChanges(committed, committed)).toEqual([])
    const narrowed = structuredClone(committed)
    narrowed.properties.merge.default = 'auto'
    expect(breakingSchemaChanges(committed, narrowed)).toEqual([
      'changes the default of `merge` from "wait" to "auto"',
    ])
  })
})

describe('releasableChanges', () => {
  const shipped = ['bin', 'src', 'plugin', '.claude-plugin']
  it('releases when a shipped path or package.json changed', () => {
    expect(releasableChanges(['docs/a.md', 'src/loop.ts'], shipped)).toBe(true)
    expect(releasableChanges(['.claude-plugin/marketplace.json'], shipped)).toBe(true)
    expect(releasableChanges(['package.json'], shipped)).toBe(true)
  })

  it('does not release docs, tests or state files', () => {
    expect(
      releasableChanges(['docs/a.md', 'tests/x.test.ts', 'PROGRESS.md', 'srcx/a.ts'], shipped),
    ).toBe(false)
  })
})

describe('changelog', () => {
  it('lists the subjects without their type, skipping docs, tests, CI and releases', () => {
    const entry = changelogEntry('0.3.1', '2026-10-24', [
      commit('feat(F-004): release merges automatically (#7)'),
      commit('fix!: rename the update key'),
      commit('docs: explain releases'),
      commit('test: cover the bump'),
      commit('chore: release v0.3.0'),
      commit('Merge tooling'),
    ])
    expect(entry).toBe(
      [
        '## v0.3.1 — 2026-10-24',
        '',
        '- Release merges automatically (#7)',
        '- Rename the update key (breaking)',
        '- Merge tooling',
        '',
      ].join('\n'),
    )
    expect(changelogEntry('0.3.2', 'd', [commit('docs: only')])).toContain('- Maintenance.')
    expect(changelogEntry('0.4.0', 'd', [commit('feat: x')], ['removes `a`'])).toBe(
      '## v0.4.0 — d\n\n- Breaking: the config schema removes `a`\n- X\n',
    )
  })

  it('inserts the entry before the newest release and keeps the intro', () => {
    const changelog = '# Changelog\n\nIntro.\n\n## v0.3.0 — 2026-10-24\n\n- Old.\n'
    expect(insertEntry(changelog, '## v0.3.1 — d\n\n- New.\n')).toBe(
      '# Changelog\n\nIntro.\n\n## v0.3.1 — d\n\n- New.\n\n## v0.3.0 — 2026-10-24\n\n- Old.\n',
    )
    expect(insertEntry('# Changelog\n', '## v0.0.1 — d\n')).toBe('# Changelog\n\n## v0.0.1 — d\n')
  })
})

describe('release', () => {
  let dir: string
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
    return r.stdout.trim()
  }
  const commitFile = (file: string, content: string, message: string) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
    git('add', '.')
    git('commit', '-q', '-m', message)
  }

  beforeEach(() => {
    vi.stubEnv('GIT_AUTHOR_NAME', 't')
    vi.stubEnv('GIT_AUTHOR_EMAIL', 't@example.com')
    vi.stubEnv('GIT_COMMITTER_NAME', 't')
    vi.stubEnv('GIT_COMMITTER_EMAIL', 't@example.com')
    vi.stubEnv('GIT_CONFIG_COUNT', '2')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'commit.gpgsign')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'false')
    vi.stubEnv('GIT_CONFIG_KEY_1', 'tag.gpgsign')
    vi.stubEnv('GIT_CONFIG_VALUE_1', 'false')
    dir = mkdtempSync(path.join(tmpdir(), 'harness-release-'))
    git('init', '-q', '-b', 'main')
    const pkg = { name: 'p', version: '0.3.0', files: ['src'] }
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    commitFile('CHANGELOG.md', '# Changelog\n\n## v0.3.0 — 2026-10-24\n\n- Old.\n', 'chore: init')
    git('tag', 'v0.3.0')
  })

  afterEach(() => vi.unstubAllEnvs())

  it('releases nothing when no shipped path changed', () => {
    commitFile('docs/a.md', 'x', 'docs: a')
    expect(release(dir)).toBeUndefined()
    expect(git('tag')).toBe('v0.3.0')
  })

  it('bumps, writes the changelog, commits and tags', () => {
    commitFile('docs/a.md', 'x', 'docs: a')
    commitFile('src/a.ts', 'x', 'feat(F-004): ship a (#7)')
    expect(release(dir, '2026-10-25')).toEqual({
      version: '0.3.1',
      notes: '- Ship a (#7)',
    })
    expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe('0.3.1')
    expect(readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8')).toBe(
      '# Changelog\n\n## v0.3.1 — 2026-10-25\n\n- Ship a (#7)\n\n## v0.3.0 — 2026-10-24\n\n- Old.\n',
    )
    expect(git('log', '-1', '--format=%s')).toBe('chore: release v0.3.1')
    expect(git('describe', '--tags', '--exact-match')).toBe('v0.3.1')
    expect(git('status', '--porcelain')).toBe('')
    // The release commit itself is not releasable.
    expect(release(dir)).toBeUndefined()
  })
})

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { configJsonSchema } from '../scripts/build-schema'
import { findRoot, loadProject, parseConfig, worktreeRoot } from '../src/config'

const minimal = { generator: { model: 'opus' }, evaluator: { model: 'opus' } }

describe('harness.config.json', () => {
  it('fills every section with defaults from a minimal config', () => {
    const config = parseConfig(minimal)
    expect(config.project).toMatchObject({
      name: 'this project',
      defaultBranch: 'main',
      branchPrefix: 'feat/',
      featureList: 'feature_list.json',
    })
    expect(config.services).toEqual({ check: 'docker info', name: 'Docker' })
    expect(config.verify.dockerLayers).toEqual(['L2', 'L3'])
    expect(config.guard).toEqual({
      bash: [],
      paths: [],
      rmAllow: ['/tmp/', 'node_modules', 'coverage'],
    })
    expect(config.caps.maxAttempts).toBe(2)
    expect(config.merge).toBe('wait')
    expect(config.format).toMatch(/prettier/)
  })

  it('keeps null for a project without services or formatter', () => {
    const config = parseConfig({ ...minimal, services: null, format: null })
    expect(config.services).toBeNull()
    expect(config.format).toBeNull()
  })

  it('rejects unknown values and invalid regular expressions with the path', () => {
    expect(() => parseConfig({ ...minimal, merge: 'sometimes' })).toThrow(/merge/)
    expect(() =>
      parseConfig({ ...minimal, guard: { bash: [{ pattern: '(unclosed', reason: 'x' }] } }),
    ).toThrow(/guard\.bash\[0\]\.pattern is not a valid regular expression/)
    expect(() => parseConfig({ evaluator: { model: 'opus' } })).toThrow(/generator/)
  })

  it('finds the project root from a subdirectory and derives the worktree root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'harness-root-'))
    writeFileSync(path.join(root, 'harness.config.json'), JSON.stringify(minimal))
    mkdirSync(path.join(root, 'src', 'deep'), { recursive: true })
    expect(findRoot(path.join(root, 'src', 'deep'))).toBe(root)
    const project = loadProject(path.join(root, 'src'))
    expect(worktreeRoot(project)).toBe(path.resolve(root, '..', `${path.basename(root)}-worktrees`))
  })

  it('ships an up-to-date JSON schema (run pnpm schema)', () => {
    const file = path.resolve(import.meta.dirname, '../schema/harness.config.schema.json')
    expect(readFileSync(file, 'utf8')).toBe(configJsonSchema())
  })
})

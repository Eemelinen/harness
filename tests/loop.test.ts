import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { pluginDir } from '../src/loop'

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

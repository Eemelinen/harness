import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveCommand } from '../src/run'

describe('resolveCommand', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('leaves other commands and platforms alone', () => {
    expect(resolveCommand('git', ['status'])).toEqual({
      cmd: 'git',
      args: ['status'],
      shell: false,
    })
    if (process.platform !== 'win32')
      expect(resolveCommand('pnpm', ['check'])).toEqual({
        cmd: 'pnpm',
        args: ['check'],
        shell: false,
      })
  })

  it.runIf(process.platform === 'win32')('runs pnpm through its entry point under pnpm run', () => {
    vi.stubEnv('npm_execpath', 'C:/pnpm/bin/pnpm.cjs')
    expect(resolveCommand('pnpm', ['harness:feature', 'block', '--reason', 'a b'])).toEqual({
      cmd: process.execPath,
      args: ['C:/pnpm/bin/pnpm.cjs', 'harness:feature', 'block', '--reason', 'a b'],
      shell: false,
    })
  })

  it.runIf(process.platform === 'win32')(
    'falls back to one quoted shell line without pnpm run',
    () => {
      vi.stubEnv('npm_execpath', '')
      expect(resolveCommand('pnpm', ['exec', 'prettier', 'C:/a b/x.json', 'say "hi"'])).toEqual({
        cmd: 'pnpm exec prettier "C:/a b/x.json" "say ""hi"""',
        args: [],
        shell: true,
      })
    },
  )
})

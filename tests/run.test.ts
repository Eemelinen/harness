import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveCommand, sessionEnv, spawnTee } from '../src/run'

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

describe('sessionEnv', () => {
  const base = {
    PATH: '/usr/bin',
    GH_TOKEN: 'ghp_x',
    GITHUB_TOKEN: 'ghs_y',
    GH_ENTERPRISE_TOKEN: 'z',
    CLAUDE_CODE_OAUTH_TOKEN: 'keep',
  }

  it('takes every GitHub token away from a session and keeps the rest', () => {
    const env = sessionEnv(base, { HARNESS_LOOP: '1' })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined()
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'keep',
      HARNESS_LOOP: '1',
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
    })
    expect(existsSync(env.GH_CONFIG_DIR!)).toBe(true)
    expect(base.GH_TOKEN).toBe('ghp_x')
  })

  it('does not let a token in through the extras either', () => {
    expect(sessionEnv(base, { GH_TOKEN: 'sneaky' }).GH_TOKEN).toBeUndefined()
  })

  const hasGh = spawnSync('gh', ['--version']).status === 0
  it.runIf(hasGh)('leaves gh without a login inside a session', () => {
    const res = spawnSync('gh', ['auth', 'token'], {
      env: sessionEnv(process.env),
      encoding: 'utf8',
    })
    expect(res.status).not.toBe(0)
    expect(res.stdout.trim()).toBe('')
  })
})

describe('spawnTee', () => {
  it('keeps a crashed process output in the log as well', async () => {
    const log = path.join(mkdtempSync(path.join(tmpdir(), 'harness-tee-')), 'traces', 'driver.log')
    const script =
      "console.log('preflight'); console.error('harness: pnpm harness:doctor reports errors'); process.exit(3)"
    const result = await spawnTee(process.execPath, ['-e', script], log, { cwd: tmpdir() })
    expect(result).toEqual({ code: 3, signal: null })
    const text = readFileSync(log, 'utf8')
    expect(text).toContain('preflight')
    expect(text).toContain('harness: pnpm harness:doctor reports errors')
  })
})

describe('spawnTee onSpawn', () => {
  it('hands over the process, so a stop signal can be passed on to it', async () => {
    const log = path.join(mkdtempSync(path.join(tmpdir(), 'harness-tee-')), 'driver.log')
    const script = "console.log('ready'); setInterval(() => {}, 1000)"
    const result = await spawnTee(process.execPath, ['-e', script], log, {
      cwd: tmpdir(),
      onSpawn: (child) => child.stdout?.once('data', () => child.kill('SIGTERM')),
    })
    expect(result).toEqual({ code: 1, signal: 'SIGTERM' })
  })
})

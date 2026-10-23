/** Process helpers shared by the commands. */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The installed package's root (prompts, plugin, templates live here). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * On Windows `pnpm` is a `.cmd` shim that spawnSync cannot run without a shell, and a shell
 * would mangle arguments with spaces (`--reason`); run pnpm's own entry point through node.
 */
export function resolveCommand(cmd: string, args: string[]): [string, string[]] {
  const pnpmEntry = process.env.npm_execpath
  if (process.platform === 'win32' && cmd === 'pnpm' && pnpmEntry)
    return [process.execPath, [pnpmEntry, ...args]]
  return [cmd, args]
}

export interface ShResult {
  code: number
  out: string
  err: string
}

export function sh(
  command: string,
  commandArgs: string[],
  opts: { cwd: string; quiet?: boolean; env?: Record<string, string | undefined> },
): ShResult {
  const [cmd, args] = resolveCommand(command, commandArgs)
  const res: SpawnSyncReturns<string> = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'pipe', 'inherit'],
    env: { ...process.env, ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  })
  return { code: res.status ?? 1, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() }
}

/** Run a configured command line (`docker info`, `pnpm db:up`) through the platform shell. */
export function shellLine(line: string, cwd: string, quiet = true): ShResult {
  const res = spawnSync(line, {
    cwd,
    shell: true,
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  return { code: res.status ?? 1, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() }
}

// Shared helpers for the harness hooks. The hooks run from Claude Code's plugin cache, which has
// no node_modules: Node built-ins only. They read harness.config.json with JSON.parse (defaults
// live with the schema in src/config.ts; the hooks repeat only the few they need) and reach the
// project's installed @eemelinen/harness package for anything that needs validation.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export async function readInput() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function projectDir(input) {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd())
}

/** The project's harness.config.json, or null when the project does not use the harness. */
export function loadConfig(root) {
  const file = path.join(root, 'harness.config.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** Absolute path of the project's `harness` CLI entry, or null when the package is missing. */
export function harnessBin(root) {
  try {
    const require = createRequire(path.join(root, 'package.json'))
    return path.join(
      path.dirname(require.resolve('@eemelinen/harness/package.json')),
      'bin',
      'harness.mjs',
    )
  } catch {
    return null
  }
}

/** Runs `harness <args>` from the project's installed package. */
export function runHarness(root, args) {
  const bin = harnessBin(root)
  if (!bin)
    return {
      code: 127,
      out: 'the @eemelinen/harness package is not installed in this project; run pnpm install',
    }
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  return { code: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() }
}

/**
 * `existsOnBase(rel)` for the guard's `exceptNewOnBranch` path rules: whether the repo-relative
 * file exists at the merge base of HEAD and the default branch (`<remote>/<defaultBranch>` first,
 * then `<defaultBranch>`). null when git can't answer: not a repository, git missing, no merge
 * base. The merge base is looked up once, on the first call.
 */
export function existsOnBaseIn(root, project) {
  const git = (args) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const branch = project?.defaultBranch || 'main'
  const remote = project?.remote || 'origin'
  let base
  return (rel) => {
    if (base === undefined) {
      base = null
      for (const ref of [`${remote}/${branch}`, branch]) {
        const res = git(['merge-base', 'HEAD', ref])
        if (res.status === 0 && res.stdout.trim()) {
          base = res.stdout.trim()
          break
        }
      }
    }
    if (base === null) return null
    // `<rev>:./<path>` resolves the path from the working directory, which may be below the top.
    const res = git(['cat-file', '-e', `${base}:./${rel}`])
    if (res.error || res.status === null) return null
    return res.status === 0
  }
}

export const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '')

/** Today as YYYY-MM-DD in local time. */
export function today() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

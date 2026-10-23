// Guard rules (see guard.mjs). Pure apart from the commit gate callback, so tests import this.
import os from 'node:os'
import path from 'node:path'

/** Separator before a command word: line start, a shell operator or whitespace. */
const SEP = '(^|[;&|\\s])'

/** Line-based like grep -E: `^` and `$` match at every line of the command. */
const has = (text, pattern) => new RegExp(pattern, 'm').test(text)

/**
 * Only where a command starts. The command is one record: `^` is its start, not the start of
 * every line, so a heredoc or commit-message line that begins with the word does not match.
 */
const hasAtCommand = (text, pattern) => new RegExp(`(^|[;&|(]\\s*)(?:${pattern})`).test(text)

/** Shell `case` glob: `*` matches any characters (including `/`), `?` exactly one. */
export function globToRegExp(glob) {
  const body = glob
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${body}$`)
}

/** Repo-relative path with forward slashes, or null when the file is outside the repo. */
export function relativePath(file, root) {
  const rel = path.relative(path.resolve(root), path.resolve(root, file))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

function insideAny(file, dirs) {
  const abs = path.resolve(file)
  return dirs.some((dir) => {
    const rel = path.relative(dir, abs)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  })
}

/**
 * The decision for one tool call: `{ block: reason }`, `{ decision, reason }` or null.
 * Pure apart from the commit gate, which runs `harness check` through `checkFeatureList`.
 */
export function evaluate(input, { root, config, loop, checkFeatureList }) {
  const guard = config.guard ?? {}
  const tool = input.tool_name
  const ti = input.tool_input ?? {}

  if (tool === 'Bash') {
    const cmd = typeof ti.command === 'string' ? ti.command : ''
    for (const rule of guard.bash ?? []) {
      if (rule.loopOnly && !loop) continue
      const hit = rule.atCommandStart ? hasAtCommand(cmd, rule.pattern) : has(cmd, rule.pattern)
      if (hit && !(rule.unless && has(cmd, rule.unless))) return { block: rule.reason }
    }
    if (has(cmd, `${SEP}(npm (i|install|add|ci)|yarn( add| install)?(\\s|$)|npx )`))
      return { block: 'use pnpm (packageManager pin); npm/yarn/npx are not allowed' }
    if (has(cmd, 'git push.*(--force|-f( |$))')) return { block: 'force push is not allowed' }
    if (has(cmd, 'git reset --hard|git checkout -- \\.|git clean -f'))
      return { block: 'destructive git command; ask the user' }
    const rmAllow = guard.rmAllow ?? ['/tmp/', 'node_modules', 'coverage']
    if (has(cmd, `${SEP}rm -[a-zA-Z]*(rf|fr)`) && !rmAllow.some((dir) => cmd.includes(dir)))
      return { block: 'rm -rf outside build/temp directories; ask the user' }
    if (loop) {
      // Driver-run session: the driver owns pushes, worktrees and the host.
      if (has(cmd, `${SEP}git push`))
        return { block: 'the loop driver pushes the branch and opens the PR; commit only' }
      if (
        has(cmd, `${SEP}git (checkout|switch) (main|master)|${SEP}git worktree (add|remove|prune)`)
      )
        return { block: 'stay on this feature branch; the loop driver manages worktrees' }
      // An unattended session must not change the host (Metsävahti F-046 put pnpm shims into ~/bin).
      if (
        has(
          cmd,
          `(${SEP}(mkdir|cp|mv|ln|touch|tee|install)\\s[^;&|]*|>>?\\s*)(~/|\\$HOME|\\$\\{HOME\\}|/[a-zA-Z]/Users/[^/]+/[^;&|]*\\.(bashrc|profile)|/[a-zA-Z]/Users/[^/]+/bin)`,
        )
      )
        return {
          block:
            'do not write to the home directory in a driver-run session; record the environment problem in PROGRESS.md and block the feature instead',
        }
    }
    if (has(cmd, `${SEP}git commit`)) {
      const result = checkFeatureList()
      if (result.code !== 0)
        return { block: `feature_list.json is invalid; fix it before committing: ${result.out}` }
    }
    return null
  }

  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
    const file = typeof ti.file_path === 'string' ? ti.file_path : ''
    // Claude Code on Windows sends backslash paths; compare normalised repo-relative paths.
    const rel = relativePath(file, root)
    if (loop && rel === null) {
      const allowed = [os.tmpdir(), path.join(os.homedir(), '.claude', 'projects')]
      if (!insideAny(file, allowed))
        return {
          decision: 'deny',
          reason: 'driver-run sessions may only write inside this worktree or the temp directory',
        }
    }
    if (rel === null) return null
    if (rel === 'pnpm-lock.yaml')
      return { decision: 'deny', reason: 'the lockfile is managed by pnpm install' }
    const content = [
      ti.old_string,
      ti.new_string,
      ti.content,
      ...(Array.isArray(ti.edits) ? ti.edits.flatMap((e) => [e.old_string, e.new_string]) : []),
    ]
      .filter((s) => typeof s === 'string')
      .join('\n')
    for (const rule of guard.paths ?? []) {
      if (!globToRegExp(rule.match).test(rel)) continue
      if (rule.tools && !rule.tools.includes(tool)) continue
      if (rule.contentPattern && !has(content, rule.contentPattern)) continue
      if (rule.decision === 'skip') return null
      return { decision: rule.decision, reason: rule.reason || `${rel} is protected` }
    }
  }
  return null
}

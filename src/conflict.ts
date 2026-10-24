/**
 * A loop PR that conflicts with the default branch gets no CI: GitHub runs no `pull_request`
 * checks until the conflict is gone. The loop driver (src/loop.ts → shepherdPr) sees `mergeable:
 * CONFLICTING` in its poll and calls mergeDefaultBranch here, which merges the default branch into
 * the feature branch in its worktree. A clean merge is checked with L1 and pushed; a merge with
 * conflicts stays in progress for a fixer session (prompts/conflict-fixer.md), and so does a clean
 * merge that fails L1 (docs/how-it-works.md → When CI fails).
 */
import { sh } from './run'

export interface BaseMergeSpec {
  /** The feature's worktree. */
  dir: string
  /** The driver's checkout; its default branch is fast-forwarded so diffs against it stay exact. */
  root: string
  remote: string
  defaultBranch: string
  /** The feature branch, pushed to `remote` after a clean merge. */
  branch: string
  /** L1 after a clean merge, run in `dir` (the driver passes `bash <project.init>`). */
  check: string[]
}

export type BaseMerge =
  /** Clean merge, L1 passed, branch pushed. */
  | { state: 'pushed'; head: string }
  /** The merge stopped with conflicts in `files`; it is left in progress (MERGE_HEAD) for a fixer. */
  | { state: 'conflicts'; files: string[] }
  /** The merge is committed but L1 fails on it; `output` is the tail of the check's output. */
  | { state: 'check-failed'; output: string }
  /** Nothing to hand to a fixer; the driver gives up on the PR with `reason`. */
  | { state: 'failed'; reason: string }

const tail = (text: string, chars = 6000) => (text.length > chars ? text.slice(-chars) : text)

export function mergeDefaultBranch(
  s: BaseMergeSpec,
  log: (line: string) => void = () => {},
): BaseMerge {
  const git = (args: string[], cwd = s.dir) => sh('git', args, { cwd, quiet: true })
  const base = `${s.remote}/${s.defaultBranch}`
  const fetched = git(['fetch', s.remote, s.defaultBranch])
  if (fetched.code !== 0) return { state: 'failed', reason: `git fetch failed: ${fetched.err}` }
  // The merge gate and the post-check diff against the local default branch.
  const onDefault = git(['rev-parse', '--abbrev-ref', 'HEAD'], s.root).out === s.defaultBranch
  const synced = onDefault ? git(['merge', '--ff-only', base], s.root) : undefined
  if (synced?.code !== 0)
    log(
      `could not fast-forward ${s.defaultBranch} in ${s.root}: ${synced ? synced.err || synced.out : `not on ${s.defaultBranch}`}`,
    )

  const before = git(['rev-parse', 'HEAD']).out
  const merged = git([
    'merge',
    '--no-edit',
    '-m',
    `chore(harness): merge ${base} into ${s.branch}`,
    '-m',
    `The pull request conflicted with ${s.defaultBranch}. Written by the loop driver (@eemelinen/harness).`,
    base,
  ])
  if (merged.code !== 0) {
    const files = git(['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean)
    if (files.length > 0) return { state: 'conflicts', files }
    git(['merge', '--abort'])
    return { state: 'failed', reason: `git merge ${base} failed: ${merged.err || merged.out}` }
  }
  const head = git(['rev-parse', 'HEAD']).out
  if (head === before)
    return {
      state: 'failed',
      reason: `GitHub reports a conflict, but ${s.branch} already contains ${base}`,
    }

  log(`merged ${base} cleanly; running ${s.check.join(' ')}`)
  const [cmd = 'true', ...args] = s.check
  const check = sh(cmd, args, { cwd: s.dir, quiet: true })
  if (check.code !== 0)
    return { state: 'check-failed', output: tail(`${check.out}\n${check.err}`.trim()) }

  const pushed = git(['push', '-u', s.remote, s.branch])
  if (pushed.code !== 0) return { state: 'failed', reason: `git push failed: ${pushed.err}` }
  return { state: 'pushed', head }
}

/** Aborts a merge left in progress in `dir` (a fixer gave up on it); true when there was one. */
export function abortMerge(dir: string): boolean {
  const inProgress = sh('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
    cwd: dir,
    quiet: true,
  })
  if (inProgress.code !== 0) return false
  return sh('git', ['merge', '--abort'], { cwd: dir, quiet: true }).code === 0
}

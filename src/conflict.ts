/**
 * A loop PR that conflicts with the default branch gets no CI: GitHub runs no `pull_request`
 * checks until the conflict is gone. The loop driver (src/loop.ts → shepherdPr) sees `mergeable:
 * CONFLICTING` in its poll and calls mergeDefaultBranch here, which merges the default branch into
 * the feature branch in its worktree. A clean merge is checked with L1 and pushed; a merge with
 * conflicts stays in progress for a fixer session (prompts/conflict-fixer.md), and so does a clean
 * merge that fails L1 (docs/how-it-works.md → When CI fails). The decisions shepherdPr takes on that
 * path (conflictStep, nextFixAttempt, fixerPrompt, fixNote, fixerGaveUp) are pure functions here, so
 * they are tested without a session; every give-up on it starts with "conflicts with <default branch>".
 */
import { describeChecks, type CiCheck } from './ci'
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

/** How every give-up reason on the conflict path starts; it is never reported as a CI stall. */
export const conflictsWith = (defaultBranch: string) => `conflicts with ${defaultBranch}`

export interface ConflictContext {
  remote: string
  defaultBranch: string
  /** `project.init`, the L1 baseline the driver ran on a clean merge. */
  init: string
}

/** What shepherdPr does with a mergeDefaultBranch result. */
export type ConflictStep =
  /** Pushed: wait for CI again; a later conflict counts only for `head`. */
  | { action: 'wait'; head: string; log: string }
  /** Start a fixer session: `problem` is its prompt's PROBLEM, `evidence` goes on the PR at a give-up. */
  | { action: 'fix'; problem: string; evidence: string; log: string }
  | { action: 'give-up'; reason: string }

export function conflictStep(merged: BaseMerge, c: ConflictContext): ConflictStep {
  const target = `${c.remote}/${c.defaultBranch}`
  switch (merged.state) {
    case 'pushed':
      return {
        action: 'wait',
        head: merged.head,
        log: `merged ${target} cleanly, L1 passed, pushed; auto-merge is still armed`,
      }
    case 'failed':
      return { action: 'give-up', reason: `${conflictsWith(c.defaultBranch)}: ${merged.reason}` }
    case 'conflicts': {
      const evidence = merged.files.map((f) => `- ${f}`).join('\n')
      return {
        action: 'fix',
        problem: `The merge stopped with conflicts in these files; it is still in progress (\`git status\`):\n\n${evidence}`,
        evidence,
        log: `merge conflicts in: ${merged.files.join(', ')}`,
      }
    }
    case 'check-failed':
      return {
        action: 'fix',
        problem: `The merge had no textual conflicts and is committed, but \`bash ${c.init}\` (the L1 baseline) fails on it: the two sides do not fit together yet. Output tail:\n\n\`\`\`\n${merged.output}\n\`\`\``,
        evidence: merged.output,
        log: `merged ${target} cleanly, but ${c.init} fails on the merge`,
      }
  }
}

/** What a fixer session in shepherdPr works on; `conflictWith` (the default branch) marks a merge. */
export interface FixTarget {
  attempt: number
  max: number
  /** The failed checks' names, for red CI. */
  failed: string
  conflictWith?: string
}

/**
 * Before each fixer session: the next attempt, or the give-up reason once `caps.maxCiFixAttempts`
 * sessions ran. A conflict uses the same budget as red CI.
 */
export function nextFixAttempt(t: FixTarget): { attempt: number } | { giveUp: string } {
  if (t.attempt < t.max) return { attempt: t.attempt + 1 }
  if (!t.conflictWith)
    return { giveUp: `CI still failing after ${t.max} fix attempt(s): ${t.failed}` }
  const prefix = conflictsWith(t.conflictWith)
  return {
    giveUp:
      t.max === 0
        ? `${prefix}: no fixer session may resolve it (caps.maxCiFixAttempts is 0)`
        : `${prefix}: still unresolved after ${t.max} fix attempt(s)`,
  }
}

/** The fixer's prompt file and the variables only it uses. */
export function fixerPrompt(s: { problem?: string; failed: CiCheck[]; evidence: string }): {
  file: 'ci-fixer.md' | 'conflict-fixer.md'
  vars: Record<string, string>
} {
  if (s.problem !== undefined) return { file: 'conflict-fixer.md', vars: { PROBLEM: s.problem } }
  return {
    file: 'ci-fixer.md',
    vars: { FAILED_CHECKS: describeChecks(s.failed), LOG_EXCERPT: s.evidence },
  }
}

/** A fixer session's run-record note or give-up reason; `t.attempt` is the session's number. */
export function fixNote(t: FixTarget, text: string): string {
  const note = t.conflictWith
    ? `${conflictsWith(t.conflictWith)}: fix ${t.attempt}/${t.max}: ${text}`
    : `ci fix ${t.attempt}/${t.max}: ${text}`
  return note.slice(0, 500)
}

/** Why the driver gives up after decideCiFix said `give-up` (the fixer blocked the feature or declined). */
export function fixerGaveUp(
  t: FixTarget,
  s: { id: string; blockedNotes?: string; reason: string },
): string {
  const why =
    s.blockedNotes !== undefined
      ? `the fixer blocked ${s.id}: ${s.blockedNotes.slice(-300)}`
      : t.conflictWith
        ? `the fixer left the merge to a human: ${s.reason}`
        : `the fixer judged the failure out of scope: ${s.reason}`
  return fixNote(t, why)
}

/**
 * Cuts a release from the commits since the last `v*` tag (docs/developing.md → Releasing). The
 * release workflow runs it after CI passes on main; it only commits and tags, the workflow pushes.
 *   pnpm exec tsx scripts/release.ts [--notes <file>]
 *
 * A release happens only when the commits change a shipped path (package.json `files`, or
 * package.json itself): docs, tests and state files reach no project. Every release bumps the
 * patch number; a breaking change (`type!:` or a `BREAKING CHANGE:` footer) bumps the minor number
 * while the version is 0.x and the major number after that.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { sh } from '../src/run'

export interface Commit {
  sha: string
  subject: string
  body: string
}

const CONVENTIONAL = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/

/** Commit types that never get a changelog line. */
const UNLISTED = new Set(['docs', 'test', 'ci', 'style'])

export function isBreaking(commit: Commit): boolean {
  return CONVENTIONAL.exec(commit.subject)?.[3] === '!' || /^BREAKING[ -]CHANGE:/m.test(commit.body)
}

export function nextVersion(current: string, commits: Commit[]): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
  if (!match) throw new Error(`package.json version ${current} is not X.Y.Z`)
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number]
  if (!commits.some(isBreaking)) return `${major}.${minor}.${patch + 1}`
  return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`
}

/** Does the diff touch something a project installs? */
export function releasableChanges(changedFiles: string[], shipped: string[]): boolean {
  return changedFiles.some(
    (file) =>
      file === 'package.json' || shipped.some((dir) => file === dir || file.startsWith(`${dir}/`)),
  )
}

/** One bullet per listed commit, its subject without the `type(scope):` prefix. */
export function changelogEntry(version: string, date: string, commits: Commit[]): string {
  const lines = commits.flatMap((c) => {
    const m = CONVENTIONAL.exec(c.subject)
    if (m && (UNLISTED.has(m[1]!) || (m[1] === 'chore' && /^release\b/.test(m[4]!)))) return []
    const text = m ? m[4]! : c.subject
    return [
      `- ${text.charAt(0).toUpperCase()}${text.slice(1)}${isBreaking(c) ? ' (breaking)' : ''}`,
    ]
  })
  return [`## v${version} — ${date}`, '', ...(lines.length ? lines : ['- Maintenance.']), ''].join(
    '\n',
  )
}

/** The entry goes before the newest release; the intro above it stays. */
export function insertEntry(changelog: string, entry: string): string {
  const at = changelog.search(/^## v/m)
  if (at === -1) return `${changelog.trimEnd()}\n\n${entry}`
  return `${changelog.slice(0, at)}${entry}\n${changelog.slice(at)}`
}

function git(root: string, args: string[]): string {
  const r = sh('git', args, { cwd: root, quiet: true })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err}`)
  return r.out
}

/** Commits and tags a release in `root`; `undefined` when nothing shipped changed. */
export function release(
  root: string,
  date: string = new Date().toISOString().slice(0, 10),
): { version: string; notes: string } | undefined {
  const tag = git(root, ['describe', '--tags', '--abbrev=0', '--match', 'v*'])
  const commits = git(root, ['log', `${tag}..HEAD`, '--no-merges', '--format=%H%x1f%s%x1f%b%x1e'])
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', subject = '', body = ''] = record.split('\x1f')
      return { sha, subject, body: body.trim() }
    })
  const pkgFile = path.join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { version: string; files?: string[] }
  const changed = git(root, ['diff', '--name-only', `${tag}..HEAD`])
    .split('\n')
    .filter(Boolean)
  if (!releasableChanges(changed, pkg.files ?? [])) return undefined

  const version = nextVersion(pkg.version, commits)
  const entry = changelogEntry(version, date, commits)
  writeFileSync(
    pkgFile,
    readFileSync(pkgFile, 'utf8').replace(/"version": "[^"]*"/, `"version": "${version}"`),
  )
  const changelogFile = path.join(root, 'CHANGELOG.md')
  writeFileSync(changelogFile, insertEntry(readFileSync(changelogFile, 'utf8'), entry))
  const notes = entry.split('\n').slice(2).join('\n').trim()
  git(root, ['add', 'package.json', 'CHANGELOG.md'])
  git(root, ['commit', '-m', `chore: release v${version}`, '-m', notes])
  git(root, ['tag', `v${version}`])
  return { version, notes }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { notes: { type: 'string' } } })
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = release(root)
  if (!result) {
    console.log('no shipped path changed since the last tag; nothing to release')
  } else {
    if (values.notes) writeFileSync(values.notes, `${result.notes}\n`)
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `version=v${result.version}\n`)
    console.log(`released v${result.version}`)
  }
}

/**
 * Moving a project to a newer harness release: the package pin and the plugin marketplace ref,
 * which must name the same tag (src/doctor.ts), then the new version's doctor.
 *
 *   harness update               update this checkout to the newest release
 *   harness update --to 0.4.0    to this release
 *   harness update --check       print the installed and the newest release, change nothing
 *
 * With `update.auto` the loop driver does the same before each feature, in its own worktree and
 * PR (src/loop.ts → maybeUpdate). Releases are found with `git ls-remote` on the package's
 * repository, so no `gh` login is needed to look.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { loadProject } from './config'
import { MARKETPLACE, packageVersion, REPO } from './doctor'
import { PACKAGE_ROOT, sh } from './run'

export const PACKAGE = '@eemelinen/harness'

/** The files an update changes; anything else in an update PR is not an update. */
export const PIN_FILES = ['package.json', 'pnpm-lock.yaml', '.claude/settings.json']

type Json = Record<string, unknown>

const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}

export function parseVersion(version: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [0, 0, 0]
  const pb = parseVersion(b) ?? [0, 0, 0]
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!
  return 0
}

/** A new major version, or a new minor version while 0.x (scripts/release.ts bumps them so). */
export function isBreaking(from: string, to: string): boolean {
  const [fMajor, fMinor] = parseVersion(from) ?? [0, 0]
  const [tMajor, tMinor] = parseVersion(to) ?? [0, 0]
  return tMajor !== fMajor || (fMajor === 0 && tMinor !== fMinor)
}

/** The newest `vX.Y.Z` in `git ls-remote --tags` output, without the `v`. */
export function newestTag(lsRemote: string): string | undefined {
  return lsRemote
    .split('\n')
    .map((line) => line.split('\t')[1]?.replace('refs/tags/', '') ?? '')
    .filter((tag) => parseVersion(tag) && tag.startsWith('v'))
    .map((tag) => tag.slice(1))
    .sort(compareVersions)
    .at(-1)
}

/** The installed package's repository as a git URL (`repository.url` in its package.json). */
export function repositoryUrl(packageRoot: string = PACKAGE_ROOT): string {
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    repository?: { url?: string }
  }
  return (pkg.repository?.url ?? `https://github.com/${REPO}.git`).replace(/^git\+/, '')
}

export function latestRelease(url: string, cwd: string): string | undefined {
  const r = sh('git', ['ls-remote', '--tags', '--refs', url, 'v*'], { cwd, quiet: true })
  if (r.code !== 0) throw new Error(`git ls-remote ${url} failed: ${r.err}`)
  return newestTag(r.out)
}

export const pinSpec = (version: string) => `github:${REPO}#v${version}`

/** Is `dir` the harness repository itself? It runs from its own checkout and has nothing to pin. */
export function isHarnessRepo(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name?: string
    }
    return pkg.name === PACKAGE
  } catch {
    return false
  }
}

/** The CLI entry of the harness installed in `dir` (after an update, the new version's). */
export function installedBin(dir: string): string {
  const require = createRequire(path.join(dir, 'package.json'))
  return path.join(path.dirname(require.resolve(`${PACKAGE}/package.json`)), 'bin', 'harness.mjs')
}

const marketplaceSource = (settings: unknown) =>
  obj(obj(obj(obj(settings).extraKnownMarketplaces)[MARKETPLACE]).source)

/**
 * `.claude/settings.json` text with the marketplace ref set to `v<version>`, edited in place so the
 * file keeps its formatting; `undefined` when it pins no harness marketplace ref.
 */
export function withMarketplaceRef(text: string, version: string): string | undefined {
  const ref = marketplaceSource(JSON.parse(text)).ref
  if (typeof ref !== 'string') return undefined
  const pattern = new RegExp(`("ref"\\s*:\\s*)"${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g')
  const matches = text.match(pattern)?.length ?? 0
  if (matches !== 1)
    throw new Error(
      `.claude/settings.json has ${matches} "ref": "${ref}" entries; set the ${MARKETPLACE} ref to v${version} by hand`,
    )
  return text.replace(pattern, `$1"v${version}"`)
}

/** The pin files before or after an update; `undefined` when the file does not exist. */
export interface PinSnapshot {
  packageJson?: unknown
  settings?: unknown
}

function withoutPin(packageJson: unknown): Json {
  const pkg = structuredClone(obj(packageJson))
  for (const key of ['dependencies', 'devDependencies']) if (pkg[key]) delete obj(pkg[key])[PACKAGE]
  return pkg
}

function withoutRef(settings: unknown): Json {
  const copy = structuredClone(obj(settings))
  delete marketplaceSource(copy).ref
  return copy
}

/**
 * Why a diff is more than a harness update; empty when it changes only the pin files, the
 * package's specifier in package.json and the marketplace ref in the settings. Only such a diff may
 * skip the merge gate (the lockfile follows from package.json and is not compared).
 */
export function notPinOnly(changed: string[], before: PinSnapshot, after: PinSnapshot): string[] {
  const reasons: string[] = []
  const extra = changed.filter((f) => !PIN_FILES.includes(f))
  if (extra.length > 0) reasons.push(`changes ${extra.join(', ')}`)
  if (
    JSON.stringify(withoutPin(before.packageJson)) !== JSON.stringify(withoutPin(after.packageJson))
  )
    reasons.push(`package.json changes more than the ${PACKAGE} specifier`)
  if (JSON.stringify(withoutRef(before.settings)) !== JSON.stringify(withoutRef(after.settings)))
    reasons.push(`.claude/settings.json changes more than the ${MARKETPLACE} ref`)
  return reasons
}

/** Pins `dir` to `version` and runs the new version's doctor; throws on failure. */
export function applyUpdate(dir: string, version: string, log: (line: string) => void): void {
  const pkg = obj(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')))
  const save = obj(pkg.dependencies)[PACKAGE] ? '--save-prod' : '--save-dev'
  log(`pnpm add ${save} ${PACKAGE}@${pinSpec(version)}`)
  const add = sh('pnpm', ['add', save, `${PACKAGE}@${pinSpec(version)}`], { cwd: dir, quiet: true })
  if (add.code !== 0) throw new Error(`pnpm add failed: ${add.err || add.out}`)
  const settingsFile = path.join(dir, '.claude', 'settings.json')
  if (existsSync(settingsFile)) {
    const text = withMarketplaceRef(readFileSync(settingsFile, 'utf8'), version)
    if (text !== undefined) {
      writeFileSync(settingsFile, text)
      log(`.claude/settings.json: ${MARKETPLACE} ref → v${version}`)
    }
  }
  const doctor = sh(process.execPath, [installedBin(dir), 'doctor'], { cwd: dir, quiet: true })
  if (doctor.code !== 0)
    throw new Error(`harness doctor of v${version} failed:\n${doctor.out}\n${doctor.err}`.trim())
}

export function updateCommand(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { to: { type: 'string' }, check: { type: 'boolean', default: false } },
  })
  const project = loadProject()
  if (isHarnessRepo(project.root)) {
    console.log('the harness repository runs from its own checkout; nothing to update')
    return 0
  }
  const installed = packageVersion()
  const target = values.to?.replace(/^v/, '') ?? latestRelease(repositoryUrl(), project.root)
  if (!target || !parseVersion(target)) throw new Error(`no release found (${target ?? 'none'})`)
  const breaking = isBreaking(installed, target) ? ' (breaking)' : ''
  console.log(`installed v${installed} · ${values.to ? 'target' : 'newest'} v${target}${breaking}`)
  if (values.check || compareVersions(target, installed) === 0) return 0
  applyUpdate(project.root, target, (line) => console.log(line))
  console.log(
    `updated to v${target}; run pnpm check, then commit as chore(harness): update to v${target}`,
  )
  return 0
}

/**
 * Moving a project to a newer harness release: the package pin and the plugin marketplace ref,
 * which must name the same tag (src/doctor.ts), then the new version's doctor.
 *
 *   harness update               update this checkout to the newest release that is not quarantined
 *   harness update --to 0.4.0    to this release
 *   harness update --check       print the installed and the target release, change nothing
 *
 * With `update.auto` the loop driver does the same before each feature, in its own worktree and
 * PR (src/loop.ts → maybeUpdate), and picks the release with pickTarget: old enough
 * (`update.minAgeHours`), not breaking unless allowed, and not quarantined. A release is
 * quarantined by a `harness-quarantine` issue in the harness repository (src/quarantine.ts).
 * Without `gh` the command falls back to the newest tag (`git ls-remote`) and cannot see quarantines.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { loadProject, type HarnessConfig } from './config'
import { MARKETPLACE, packageVersion, REPO } from './doctor'
import { harnessRepo, listIssues, type Issue } from './retro'
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

/** The repository whose releases and quarantine issues the rollout reads. */
export const rolloutRepo = (config: HarnessConfig) => harnessRepo(config) ?? REPO

export const QUARANTINE_LABEL = 'harness-quarantine'

export interface Release {
  version: string
  publishedAt: string
  draft: boolean
  prerelease: boolean
}

export function listReleases(repo: string, cwd: string): Release[] {
  const r = sh(
    'gh',
    [
      'release',
      'list',
      '--repo',
      repo,
      '--limit',
      '50',
      '--json',
      'tagName,publishedAt,isDraft,isPrerelease',
    ],
    { cwd, quiet: true },
  )
  if (r.code !== 0) throw new Error(`gh release list --repo ${repo} failed: ${r.err}`)
  return (
    JSON.parse(r.out || '[]') as {
      tagName: string
      publishedAt: string
      isDraft: boolean
      isPrerelease: boolean
    }[]
  )
    .filter((x) => x.tagName.startsWith('v') && parseVersion(x.tagName))
    .map((x) => ({
      version: x.tagName.slice(1),
      publishedAt: x.publishedAt,
      draft: x.isDraft,
      prerelease: x.isPrerelease,
    }))
}

/**
 * The versions named in quarantine issue titles. An issue keeps its versions quarantined while it is
 * open or closed as completed (the fix merged; the bad release stays bad); closing it as not
 * planned lifts the quarantine (a false alarm).
 */
export function quarantinedVersions(
  issues: Pick<Issue, 'title' | 'state' | 'stateReason'>[],
): Set<string> {
  const versions = new Set<string>()
  for (const issue of issues) {
    if (issue.state === 'CLOSED' && issue.stateReason === 'NOT_PLANNED') continue
    for (const m of issue.title.matchAll(/\bv(\d+\.\d+\.\d+)\b/g)) versions.add(m[1]!)
  }
  return versions
}

export function listQuarantined(repo: string, cwd: string): Set<string> {
  return quarantinedVersions(listIssues(repo, QUARANTINE_LABEL, 'all', cwd))
}

export type Target =
  | { action: 'update'; version: string; why: string }
  | { action: 'none'; reason?: string }
  | { action: 'notify'; version: string; reason: string }

const newestOf = (releases: Release[]) =>
  [...releases].sort((a, b) => compareVersions(b.version, a.version))[0]

/**
 * The release to move to. Normally the newest published release newer than `installed` that is
 * not quarantined, not breaking (unless `allowBreaking`) and at least `minAgeHours` old. When
 * `installed` itself is quarantined, the age does not count: move forward to the newest eligible
 * release (the fix) or, when there is none, back to the newest older release that is not
 * quarantined.
 */
export function pickTarget(s: {
  installed: string
  releases: Release[]
  quarantined: Set<string>
  now: number
  minAgeHours: number
  allowBreaking: boolean
}): Target {
  const clean = s.releases.filter((r) => !r.draft && !r.prerelease && !s.quarantined.has(r.version))
  const allowed = (r: Release) => s.allowBreaking || !isBreaking(s.installed, r.version)
  const newer = clean.filter((r) => compareVersions(r.version, s.installed) > 0)
  if (s.quarantined.has(s.installed)) {
    const why = `v${s.installed} is quarantined`
    const forward = newestOf(newer.filter(allowed))
    if (forward) return { action: 'update', version: forward.version, why }
    const back = newestOf(clean.filter((r) => compareVersions(r.version, s.installed) < 0))
    if (back) return { action: 'update', version: back.version, why }
    return {
      action: 'notify',
      version: s.installed,
      reason: `harness ${why} and no other release is available; fix it by hand`,
    }
  }
  if (newer.length === 0) return { action: 'none' }
  const compatible = newer.filter(allowed)
  if (compatible.length === 0) {
    const breaking = newestOf(newer)!
    return {
      action: 'notify',
      version: breaking.version,
      reason: `harness v${breaking.version} is a breaking release (installed v${s.installed}); update by hand (pnpm harness:update --to ${breaking.version}) or set update.allowBreaking`,
    }
  }
  const ageHours = (r: Release) => (s.now - Date.parse(r.publishedAt)) / 3_600_000
  const ready = newestOf(compatible.filter((r) => ageHours(r) >= s.minAgeHours))
  if (ready) return { action: 'update', version: ready.version, why: 'newer release' }
  const waiting = newestOf(compatible)!
  return {
    action: 'none',
    reason: `v${waiting.version} is ${ageHours(waiting).toFixed(1)} h old; waiting until it is ${s.minAgeHours} h old (update.minAgeHours)`,
  }
}

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
  let target = values.to?.replace(/^v/, '')
  if (!target) {
    const repo = rolloutRepo(project.config)
    if (sh('gh', ['auth', 'status'], { cwd: project.root, quiet: true }).code === 0) {
      // By hand there is no waiting time; quarantines and breaking releases still count.
      const plan = pickTarget({
        installed,
        releases: listReleases(repo, project.root),
        quarantined: listQuarantined(repo, project.root),
        now: Date.now(),
        minAgeHours: 0,
        allowBreaking: project.config.update.allowBreaking,
      })
      if (plan.action !== 'update') {
        console.log(
          `installed v${installed}: ${plan.action === 'none' ? (plan.reason ?? 'up to date') : plan.reason}`,
        )
        return 0
      }
      target = plan.version
      console.log(`installed v${installed} · target v${target} (${plan.why})`)
    } else {
      target = latestRelease(repositoryUrl(), project.root)
      console.log(
        `installed v${installed} · newest v${target ?? '?'} (gh is not logged in: quarantines are not checked)`,
      )
    }
  } else {
    console.log(`installed v${installed} · target v${target}`)
  }
  if (!target || !parseVersion(target)) throw new Error(`no release found (${target ?? 'none'})`)
  if (isBreaking(installed, target)) console.log('note: a breaking release; read its notes')
  if (values.check || compareVersions(target, installed) === 0) return 0
  applyUpdate(project.root, target, (line) => console.log(line))
  console.log(
    `updated to v${target}; run pnpm check, then commit as chore(harness): update to v${target}`,
  )
  return 0
}

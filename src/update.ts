/**
 * Moving a project to a newer harness release: the package pin and the plugin marketplace ref,
 * which must name the same tag (src/doctor.ts), then the new version's doctor.
 *
 *   harness update               update this checkout to the newest release that is not quarantined
 *   harness update --to 0.4.0    to this release
 *   harness update --check       print the installed and the target release, change nothing
 *
 * With `update.auto` the loop driver does the same before each feature, in its own worktree and
 * PR (src/loop.ts → maybeUpdate), and picks the release with pickTarget: verified by a canary
 * project or claimed by this one as canary (src/rollout.ts), not breaking unless allowed, and not
 * quarantined. A release is quarantined by a `harness-quarantine` issue in the harness repository
 * (src/quarantine.ts).
 * Without `gh` the command falls back to the newest tag (`git ls-remote`) and cannot see quarantines.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { loadProject, type HarnessConfig } from './config'
import { MARKETPLACE, packageVersion, REPO } from './doctor'
import { harnessRepo, listIssues, type Issue } from './retro'
import { listRollouts, rolloutStates } from './rollout'
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

/** What the rollout says about a release (src/rollout.ts → rolloutStates). */
export interface RolloutView {
  /** The project that verified it as canary. */
  verified?: string
  /** The claim that holds the release now. */
  claim?: { project: string; until: string; commentId: string }
}

export type Target =
  | { action: 'update'; version: string; why: string }
  | { action: 'canary'; version: string; why: string; resume?: string }
  | { action: 'none'; reason?: string }
  | { action: 'notify'; version: string; reason: string }

const newestOf = (releases: Release[]) =>
  [...releases].sort((a, b) => compareVersions(b.version, a.version))[0]

const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`

/**
 * The release to move to (docs/how-it-works.md → Rollout safety). Candidates are published releases
 * newer than `installed` that are not quarantined and not breaking (unless `allowBreaking`).
 *
 * - The newest candidate verified by a canary is taken.
 * - When the newest candidate is not verified: a project whose claim holds it continues as its
 *   canary (`resume`); while another project holds it, an older verified candidate is taken or
 *   nothing; when nobody holds it, a project with `canary` claims it, and one without takes only an
 *   older verified candidate.
 * - When `installed` is quarantined: forward to the newest verified candidate, else back to the
 *   newest older release that is not quarantined (moving back needs no verification).
 */
export function pickTarget(s: {
  installed: string
  releases: Release[]
  quarantined: Set<string>
  rollouts: Map<string, RolloutView>
  me: string
  canary: boolean
  allowBreaking: boolean
}): Target {
  const clean = s.releases.filter((r) => !r.draft && !r.prerelease && !s.quarantined.has(r.version))
  const allowed = (r: Release) => s.allowBreaking || !isBreaking(s.installed, r.version)
  const verifiedBy = (r: Release) => s.rollouts.get(r.version)?.verified
  const newer = clean.filter((r) => compareVersions(r.version, s.installed) > 0)
  const verified = newestOf(newer.filter(allowed).filter(verifiedBy))
  const take = (r: Release, why: string): Target => ({ action: 'update', version: r.version, why })
  if (s.quarantined.has(s.installed)) {
    const why = `v${s.installed} is quarantined`
    if (verified)
      return take(verified, `${why}; v${verified.version} verified by ${verifiedBy(verified)}`)
    const back = newestOf(clean.filter((r) => compareVersions(r.version, s.installed) < 0))
    if (back) return take(back, why)
    return {
      action: 'notify',
      version: s.installed,
      reason: `harness ${why} and no verified or older release is available; fix it by hand`,
    }
  }
  if (newer.length === 0) return { action: 'none' }
  const compatible = newer.filter(allowed)
  const newest = newestOf(compatible)
  if (!newest) {
    const breaking = newestOf(newer)!
    return {
      action: 'notify',
      version: breaking.version,
      reason: `harness v${breaking.version} is a breaking release (installed v${s.installed}); update by hand (pnpm harness:update --to ${breaking.version}) or set update.allowBreaking`,
    }
  }
  if (verifiedBy(newest)) return take(newest, `verified by ${verifiedBy(newest)}`)
  const claim = s.rollouts.get(newest.version)?.claim
  if (claim?.project === s.me)
    return {
      action: 'canary',
      version: newest.version,
      why: `this project's canary claim on v${newest.version} holds until ${hhmm(claim.until)}`,
      resume: claim.commentId,
    }
  const fallback = verified && take(verified, `verified by ${verifiedBy(verified)}`)
  if (claim)
    return (
      fallback || {
        action: 'none',
        reason: `v${newest.version} is being tested by ${claim.project} until ${hhmm(claim.until)}`,
      }
    )
  if (s.canary)
    return {
      action: 'canary',
      version: newest.version,
      why: `nobody has tested v${newest.version} yet`,
    }
  return (
    fallback || {
      action: 'none',
      reason: `v${newest.version} waits for a canary project to verify it (update.canary is off here)`,
    }
  )
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

/**
 * The root of the harness installed in `dir`, read from the file system on every call. Node caches
 * module real paths for the life of the process, so after `pnpm install` repointed
 * `node_modules/@eemelinen/harness` at a new version, `require.resolve` in the running driver
 * still returned the old one. v0.3.1–v0.3.4 restarted onto their own old code that way, failed
 * the doctor on the new pins, and quarantined a good release.
 */
export function installedRoot(dir: string): string {
  const link = path.join(dir, 'node_modules', ...PACKAGE.split('/'))
  if (existsSync(link)) return realpathSync.native(link)
  // The harness repository itself: the package resolves to its own checkout.
  const require = createRequire(path.join(dir, 'package.json'))
  return path.dirname(require.resolve(`${PACKAGE}/package.json`))
}

/** The CLI entry of the harness installed in `dir` (after an update, the new version's). */
export const installedBin = (dir: string) => path.join(installedRoot(dir), 'bin', 'harness.mjs')

export function installedVersion(dir: string): string {
  const pkg = JSON.parse(readFileSync(path.join(installedRoot(dir), 'package.json'), 'utf8')) as {
    version: string
  }
  return pkg.version
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
      // By hand a human decides: the newest release that is not quarantined, with its rollout state.
      const quarantined = listQuarantined(repo, project.root)
      const newest = newestOf(
        listReleases(repo, project.root).filter(
          (r) =>
            !r.draft &&
            !r.prerelease &&
            !quarantined.has(r.version) &&
            compareVersions(r.version, installed) > 0,
        ),
      )
      if (!newest) {
        console.log(`installed v${installed}: up to date`)
        return 0
      }
      target = newest.version
      const state = rolloutStates(listRollouts(repo, project.root), Date.now()).get(target)
      const rollout = state?.verified
        ? `verified by ${state.verified}`
        : state?.claim
          ? `being tested by ${state.claim.project} until ${hhmm(state.claim.until)}`
          : 'not tested by a canary yet'
      console.log(`installed v${installed} · target v${target} (${rollout})`)
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

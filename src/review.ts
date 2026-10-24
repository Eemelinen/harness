/**
 * The merge gate for loop PRs that change what sessions may do (docs/self-improvement.md → Safety).
 *
 * A PR that touches `reviewPaths`, or builds a retro issue marked as a safety change, needs review.
 * With `review.mode: "evaluate"` a read-only safety-review session decides (prompts/safety-review.md)
 * and a `safe` verdict auto-merges; `human` always waits. Some changes never auto-merge whatever the
 * session says, because they would let a loop widen its own limits; `hardStops()` finds those
 * deterministically from the harness config and Claude settings before and after the change.
 */
import { z } from 'zod'

import { parseConfig, type HarnessConfig } from './config'

/** The JSON files a hard stop compares; `undefined` when the file does not exist. */
export interface Snapshot {
  config?: unknown
  settings?: unknown
  settingsLocal?: unknown
}

const PLUGIN_KEY = 'harness@eemelinen-harness'

/** An allow entry that permits every Bash command (or every tool). */
const UNSCOPED = /^(\*|Bash|Bash\(\s*\*?\s*\)|Bash\(\*\s*:\s*\*\))$/

type Json = Record<string, unknown>

const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

function parsedConfig(raw: unknown): HarnessConfig | undefined {
  try {
    return parseConfig(raw)
  } catch {
    return undefined
  }
}

function settingsStops(name: string, before: unknown, after: unknown): string[] {
  if (after === undefined) return before === undefined ? [] : [`deletes ${name}`]
  const stops: string[] = []
  const b = obj(before)
  const a = obj(after)
  const bPerm = obj(b.permissions)
  const aPerm = obj(a.permissions)
  if (obj(b.enabledPlugins)[PLUGIN_KEY] === true && obj(a.enabledPlugins)[PLUGIN_KEY] !== true)
    stops.push(`${name} disables the ${PLUGIN_KEY} plugin`)
  const removedDeny = strings(bPerm.deny).filter((d) => !strings(aPerm.deny).includes(d))
  if (removedDeny.length > 0) stops.push(`${name} removes deny rules: ${removedDeny.join(', ')}`)
  const unscoped = strings(aPerm.allow).filter(
    (e) => UNSCOPED.test(e) && !strings(bPerm.allow).includes(e),
  )
  if (unscoped.length > 0) stops.push(`${name} allows every command: ${unscoped.join(', ')}`)
  if (aPerm.defaultMode === 'bypassPermissions' && bPerm.defaultMode !== 'bypassPermissions')
    stops.push(`${name} sets permissions.defaultMode to bypassPermissions`)
  return stops
}

/**
 * Changes that never auto-merge: the review itself loosened, permissions bypassed, the plugin (and
 * with it the guard) switched off, deny rules removed, every command allowed.
 */
export function hardStops(before: Snapshot, after: Snapshot): string[] {
  const stops: string[] = []
  if (before.config !== undefined || after.config !== undefined) {
    const b = parsedConfig(before.config)
    const a = parsedConfig(after.config)
    if (!a) stops.push('harness.config.json is missing or invalid after the change')
    else if (b) {
      const removed = b.reviewPaths.filter((p) => !a.reviewPaths.includes(p))
      if (removed.length > 0) stops.push(`removes reviewPaths: ${removed.join(', ')}`)
      if (JSON.stringify(a.review) !== JSON.stringify(b.review))
        stops.push('changes the review settings')
      if (a.generator.permissionMode !== b.generator.permissionMode)
        stops.push(`changes generator.permissionMode to ${a.generator.permissionMode}`)
      const unscoped = a.allowedTools.filter((t) => UNSCOPED.test(t) && !b.allowedTools.includes(t))
      if (unscoped.length > 0)
        stops.push(`allowedTools allows every command: ${unscoped.join(', ')}`)
    }
  }
  stops.push(...settingsStops('.claude/settings.json', before.settings, after.settings))
  stops.push(
    ...settingsStops('.claude/settings.local.json', before.settingsLocal, after.settingsLocal),
  )
  return stops
}

const safetyVerdictSchema = z.object({
  verdict: z.enum(['safe', 'unsafe']),
  reasons: z.array(z.string().min(1)).min(1),
})

export type SafetyVerdict = z.infer<typeof safetyVerdictSchema>

export function parseSafetyVerdict(
  result: Record<string, unknown> | undefined,
): SafetyVerdict | undefined {
  const parsed = safetyVerdictSchema.safeParse(result?.structured_output)
  return parsed.success ? parsed.data : undefined
}

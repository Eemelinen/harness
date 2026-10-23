/**
 * `feature_list.json`, the harness feature tracker: schema, rules and the pure helpers the other
 * commands build on.
 *
 * Rules enforced here so that neither a human nor an agent can leave the list in an inconsistent
 * state: unique `F-NNN` ids, at most one `in_progress` feature (WIP=1), `passing` requires
 * recorded evidence, `blocked` requires a note, every verification step names its layer (`L1:`
 * static, `L2:` runtime, `L3:` end-to-end, or `manual:`), `depends_on` ids exist and form no
 * cycle, and a feature may only be `in_progress` when every dependency is `passing`.
 *
 * The ticket format and any extra fields (`epic`, `design`, …) come from `harness.config.json` →
 * `features`; a field that is not declared there is rejected rather than silently dropped.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { configSchema, type HarnessConfig } from './config'
import { resolveCommand } from './run'

export type FeaturesConfig = HarnessConfig['features']

export const featureStatuses = ['not_started', 'in_progress', 'blocked', 'passing'] as const
export type FeatureStatus = (typeof featureStatuses)[number]

export const FEATURE_ID = /^F-\d{3}$/

const featureId = z.string().regex(FEATURE_ID, 'id must look like F-001')

const verificationStep = z
  .string()
  .regex(/^(L1|L2|L3|manual): \S.*$/, 'must start with "L1: ", "L2: ", "L3: " or "manual: "')

const baseShape = {
  id: featureId,
  priority: z.number().int().nonnegative(),
  area: z.string().min(1),
  title: z.string().min(1),
  user_visible_behavior: z.string().min(1),
  status: z.enum(featureStatuses),
  /** Ids that must be `passing` before this feature may become `in_progress`. */
  depends_on: z.array(featureId).default([]),
  /** Product ticket this feature implements (format: `features.ticketPattern`). */
  ticket: z.string().optional(),
  /** Repo path (+ heading anchor) of the spec to read before implementing. */
  spec: z.string().min(1).optional(),
  verification: z.array(verificationStep).min(1),
  evidence: z.array(z.string().min(1)),
  /** Driver-run sessions spent on this feature; the driver auto-blocks at `max_attempts`. */
  attempts: z.number().int().nonnegative().default(0),
  max_attempts: z.number().int().positive().optional(),
  notes: z.string(),
}

const baseFeatureSchema = z.object(baseShape)

/** A feature; project-specific fields from `features.extraFields` appear as extra keys. */
export type Feature = z.infer<typeof baseFeatureSchema> & { [field: string]: unknown }

const baseKeyOrder = [
  'id',
  'priority',
  'area',
  'title',
  'user_visible_behavior',
  'status',
  'depends_on',
  'ticket',
  'spec',
  'verification',
  'evidence',
  'attempts',
  'max_attempts',
  'notes',
]

export const defaultFeaturesConfig: FeaturesConfig = configSchema.shape.features.parse({})

function featureSchemaFor(features: FeaturesConfig) {
  const extra: Record<string, z.ZodType> = {}
  for (const [name, field] of Object.entries(features.extraFields)) {
    const item = field.pattern
      ? z
          .string()
          .regex(
            new RegExp(field.pattern),
            `${name} must look like ${field.example ?? field.pattern}`,
          )
      : z.string().min(1)
    extra[name] = (field.type === 'string[]' ? z.array(item) : item).optional()
  }
  return z.strictObject({
    ...baseShape,
    ticket: z
      .string()
      .regex(new RegExp(features.ticketPattern), `ticket must look like ${features.ticketExample}`)
      .optional(),
    ...extra,
  })
}

function featureListSchemaFor(features: FeaturesConfig) {
  return z
    .looseObject({
      project: z.string().min(1),
      last_updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'last_updated must be YYYY-MM-DD'),
      rules: z.object({
        single_active_feature: z.literal(true),
        passing_requires_evidence: z.literal(true),
        do_not_skip_verification: z.literal(true),
      }),
      status_legend: z.record(z.enum(featureStatuses), z.string().min(1)),
      features: z.array(featureSchemaFor(features)).min(1),
    })
    .superRefine((list, ctx) => checkRules(list.features as Feature[], ctx))
}

export interface FeatureList {
  project: string
  last_updated: string
  rules: {
    single_active_feature: true
    passing_requires_evidence: true
    do_not_skip_verification: true
  }
  status_legend: Partial<Record<FeatureStatus, string>>
  features: Feature[]
  [key: string]: unknown
}

function checkRules(features: Feature[], ctx: z.RefinementCtx) {
  const byId = new Map<string, Feature>()
  features.forEach((feature, index) => {
    const at = (field: string) => ['features', index, field]
    if (byId.has(feature.id)) {
      ctx.addIssue({ code: 'custom', path: at('id'), message: `duplicate id ${feature.id}` })
    }
    byId.set(feature.id, feature)
    if (feature.status === 'passing' && feature.evidence.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: at('evidence'),
        message: `${feature.id} is passing but has no evidence`,
      })
    }
    if (feature.status === 'blocked' && feature.notes.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: at('notes'),
        message: `${feature.id} is blocked but notes do not say why`,
      })
    }
    // pnpm forwards a literal `--` to the script, and vitest/playwright then ignore the file
    // filter and run the whole suite. Passing features keep their recorded commands.
    if (feature.status !== 'passing') {
      feature.verification.forEach((step, stepIndex) => {
        if (/pnpm test:[\w-]+ -- /.test(step)) {
          ctx.addIssue({
            code: 'custom',
            path: ['features', index, 'verification', stepIndex],
            message: `${feature.id}: drop the "--" in "${step.split(' (')[0]}"; the test runner ignores files after it`,
          })
        }
      })
    }
  })

  features.forEach((feature, index) => {
    const at = (field: string) => ['features', index, field]
    for (const dep of feature.depends_on) {
      if (dep === feature.id) {
        ctx.addIssue({
          code: 'custom',
          path: at('depends_on'),
          message: `${feature.id} depends on itself`,
        })
      } else if (!byId.has(dep)) {
        ctx.addIssue({
          code: 'custom',
          path: at('depends_on'),
          message: `${feature.id} depends on unknown feature ${dep}`,
        })
      }
    }
    if (feature.status === 'in_progress') {
      const waiting = feature.depends_on.filter((dep) => byId.get(dep)?.status !== 'passing')
      if (waiting.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: at('status'),
          message: `${feature.id} is in_progress but depends on non-passing ${waiting.join(', ')}`,
        })
      }
    }
  })

  const cycle = findDependencyCycle(features)
  if (cycle) {
    ctx.addIssue({
      code: 'custom',
      path: ['features'],
      message: `depends_on cycle: ${cycle.join(' → ')}`,
    })
  }

  const active = features.filter((f) => f.status === 'in_progress').map((f) => f.id)
  if (active.length > 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['features'],
      message: `only one feature may be in_progress (WIP=1); found ${active.join(', ')}`,
    })
  }
}

/** Returns the first dependency cycle found (as a path of ids), or null. */
function findDependencyCycle(features: Feature[]): string[] | null {
  const byId = new Map(features.map((f) => [f.id, f]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    const mark = state.get(id)
    if (mark === 'done') return null
    if (mark === 'visiting') return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, 'visiting')
    stack.push(id)
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(dep)) continue
      const found = visit(dep)
      if (found) return found
    }
    stack.pop()
    state.set(id, 'done')
    return null
  }
  for (const feature of features) {
    const found = visit(feature.id)
    if (found) return found
  }
  return null
}

/** Parse and validate a raw feature list; throws with a readable report on failure. */
export function validateFeatureList(
  raw: unknown,
  features: FeaturesConfig = defaultFeaturesConfig,
): FeatureList {
  const result = featureListSchemaFor(features).safeParse(raw)
  if (!result.success) {
    throw new Error(`feature_list.json is invalid:\n${formatIssues(result.error.issues)}`)
  }
  return result.data as FeatureList
}

/**
 * One line per distinct message with the paths it occurs at, so an undeclared field on every
 * feature reads as one problem rather than a hundred.
 */
function formatIssues(issues: z.core.$ZodIssue[]): string {
  const byMessage = new Map<string, string[]>()
  for (const issue of issues) {
    const at = issue.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('')
    byMessage.set(issue.message, [...(byMessage.get(issue.message) ?? []), at.replace(/^\./, '')])
  }
  return [...byMessage]
    .map(([message, paths]) => {
      const shown = paths.filter(Boolean).slice(0, 5).join(', ')
      const more = paths.length > 5 ? ` and ${paths.length - 5} more` : ''
      return `✖ ${message}${shown ? `\n  → at ${shown}${more}` : ''}`
    })
    .join('\n')
}

/** A `manual:` step cannot be verified unattended; the driver leaves such features to humans. */
export function isHumanOnly(feature: Feature): boolean {
  return feature.verification.some((step) => step.startsWith('manual:'))
}

/** `not_started` with every dependency `passing`. Ignores WIP=1; callers check that. */
export function isReady(feature: Feature, list: FeatureList): boolean {
  if (feature.status !== 'not_started') return false
  const byId = new Map(list.features.map((f) => [f.id, f]))
  return feature.depends_on.every((dep) => byId.get(dep)?.status === 'passing')
}

export interface NextFeatureOptions {
  /** Include features with `manual:` verification steps (default: false — they are human-run). */
  includeHumanOnly?: boolean
  /** Ids to skip, e.g. features with an open pull request. */
  exclude?: readonly string[]
}

/** Lowest `priority` (then id) ready feature, or undefined when nothing is ready. */
export function nextReadyFeature(
  list: FeatureList,
  options: NextFeatureOptions = {},
): Feature | undefined {
  const excluded = new Set(options.exclude ?? [])
  return list.features
    .filter((f) => isReady(f, list))
    .filter((f) => options.includeHumanOnly || !isHumanOnly(f))
    .filter((f) => !excluded.has(f.id))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0]
}

/** One-line status summary including the verified-completion ratio (VCR) and the ready count. */
export function summarizeFeatureList(list: FeatureList): string {
  const count = (status: FeatureStatus) => list.features.filter((f) => f.status === status).length
  const passing = count('passing')
  const activated = passing + count('in_progress')
  const vcr = activated === 0 ? 'n/a' : `${passing}/${activated}`
  const active = list.features.find((f) => f.status === 'in_progress')
  const ready = list.features.filter((f) => isReady(f, list))
  const unattended = ready.filter((f) => !isHumanOnly(f)).length
  return [
    `${list.features.length} features`,
    `${passing} passing`,
    `${count('in_progress')} in_progress${active ? ` (${active.id})` : ''}`,
    `${count('blocked')} blocked`,
    `${count('not_started')} not_started`,
    `${ready.length} ready (${unattended} unattended)`,
    `VCR ${vcr}`,
  ].join(' · ')
}

export function readFeatureList(
  file: string,
  features: FeaturesConfig = defaultFeaturesConfig,
): FeatureList {
  return validateFeatureList(JSON.parse(readFileSync(file, 'utf8')), features)
}

/** The written key order: the base fields, each extra field after the key it names. */
export function featureKeyOrder(features: FeaturesConfig = defaultFeaturesConfig): string[] {
  const order = [...baseKeyOrder]
  const extras = new Set<string>()
  for (const [name, field] of Object.entries(features.extraFields)) {
    const after = order.indexOf(field.after)
    let at = after === -1 ? order.indexOf('verification') : after + 1
    // Two extra fields after the same key keep their config order.
    while (extras.has(order[at] ?? '')) at += 1
    order.splice(at, 0, name)
    extras.add(name)
  }
  return order
}

/** Stable key order so diffs stay readable regardless of which command wrote the file. */
export function normalizeFeature(
  feature: Feature,
  features: FeaturesConfig = defaultFeaturesConfig,
): Feature {
  const ordered: Record<string, unknown> = {}
  for (const key of featureKeyOrder(features)) {
    if (feature[key] !== undefined) ordered[key] = feature[key]
  }
  return ordered as Feature
}

export interface WriteOptions {
  file: string
  features?: FeaturesConfig
  /** Run Prettier on the written file (default: true). */
  format?: boolean
  /** Where Prettier runs, so it finds the project's install and config (default: the file's directory). */
  cwd?: string
}

/** Validate, normalise, write and format the feature list. Throws if the list is invalid. */
export function writeFeatureList(list: FeatureList, options: WriteOptions): void {
  const features = options.features ?? defaultFeaturesConfig
  const normalized: FeatureList = {
    ...list,
    features: list.features.map((f) => normalizeFeature(f, features)),
  }
  validateFeatureList(normalized, features)
  writeFileSync(options.file, `${JSON.stringify(normalized, null, 2)}\n`)
  if (options.format ?? true) {
    const { cmd, args, shell } = resolveCommand('pnpm', [
      'exec',
      'prettier',
      '--write',
      '--log-level',
      'warn',
      options.file,
    ])
    spawnSync(cmd, args, {
      cwd: options.cwd ?? path.dirname(options.file),
      shell,
      stdio: 'inherit',
    })
  }
}

/** Today as YYYY-MM-DD in local time (the format `last_updated` and evidence lines use). */
export function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

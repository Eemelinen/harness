/** Library entry: what project scripts (e.g. a ticket importer) may build on. */
export { configSchema, findRoot, loadProject, parseConfig } from './config'
export type { ConfigInput, HarnessConfig, Project } from './config'
export * from './feature-list'
export { cleanState } from './clean-state'
export { parseStep, verifyFeature } from './verify'
export type { VerificationStep, VerifyOptions, VerifyOutcome } from './verify'

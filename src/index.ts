/** Library entry: what project scripts (e.g. a ticket importer) may build on. */
export { configSchema, findRoot, loadProject, parseConfig } from './config'
export type { ConfigInput, HarnessConfig, Project } from './config'
export * from './feature-list'
export { cleanState } from './clean-state'
export { parseStep, verifyFeature } from './verify'
export type { VerificationStep, VerifyOptions, VerifyOutcome } from './verify'
// Issue formats a triage service (harness-updater) reads the way the loop does.
export { fingerprintOf, issueContext, MARKER, parseIssueFeature, queuedLabel } from './retro'
export type { Issue, IssueFeature } from './retro'
export { QUARANTINE_LABEL, compareVersions, quarantinedVersions } from './update'
export {
  ROLLOUT_LABEL,
  VERIFIED_LABEL,
  rolloutState,
  rolloutStates,
  rolloutVersion,
} from './rollout'
export type { RolloutIssue, RolloutState } from './rollout'

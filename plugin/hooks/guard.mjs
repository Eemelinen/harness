// PreToolUse hook for Bash, Edit|Write|MultiEdit and Agent|Task (AGENTS.md → Constraints, enforced
// deterministically). Core rules apply to every harness project; project rules come from
// harness.config.json → guard. Inert in a project without harness.config.json.
//   exit 2 + stderr  → the tool call is blocked and Claude sees the reason
//   JSON on stdout   → permissionDecision deny | ask
import { evaluate } from './guard-rules.mjs'
import { existsOnBaseIn, loadConfig, projectDir, readInput, runHarness } from './lib.mjs'

async function main() {
  const input = await readInput()
  const root = projectDir(input)
  const config = loadConfig(root)
  if (!config) return
  const outcome = evaluate(input, {
    root,
    config,
    loop: process.env.HARNESS_LOOP === '1',
    checkFeatureList: () => runHarness(root, ['check']),
    existsOnBase: existsOnBaseIn(root, config.project),
  })
  if (!outcome) return
  if (outcome.block) {
    process.stderr.write(`guard: ${outcome.block}\n`)
    process.exitCode = 2
    return
  }
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: outcome.decision,
        permissionDecisionReason: `guard: ${outcome.reason}`,
      },
    }),
  )
}

await main()

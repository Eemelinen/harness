/**
 * `harness <command>`: the CLI the project's `pnpm harness:*` scripts call.
 *
 *   harness check [file]        validate feature_list.json (lint-staged passes the file)
 *   harness feature <cmd> …     state transitions (src/feature.ts)
 *   harness verify <id> …       run a feature's layers and record evidence (src/verify.ts)
 *   harness clean-state …       clock-out gate (src/clean-state.ts)
 *   harness loop …              unattended driver (src/loop.ts)
 *   harness report              past driver runs
 *   harness doctor              is the project wired correctly (src/doctor.ts)
 *   harness config              print the resolved configuration
 */
import { cleanStateCommand } from './clean-state'
import { loadProject } from './config'
import { doctorCommand } from './doctor'
import { featureCommand } from './feature'
import { readFeatureList, summarizeFeatureList } from './feature-list'
import { loopCommand } from './loop'
import { verifyCommand } from './verify'

const usage = `usage: harness <check|feature|verify|clean-state|loop|report|doctor|config> [args]
docs: https://github.com/Eemelinen/harness#readme`

function check(argv: string[]): number {
  const project = loadProject()
  const file = project.resolve(argv[0] ?? project.config.project.featureList)
  const list = readFeatureList(file, project.config.features)
  console.log(`${project.config.project.featureList} OK — ${summarizeFeatureList(list)}`)
  return 0
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'check':
      return check(rest)
    case 'feature':
      return featureCommand(rest)
    case 'verify':
      return verifyCommand(rest)
    case 'clean-state':
      return cleanStateCommand(rest)
    case 'loop':
      return loopCommand(rest)
    case 'report':
      return loopCommand(['--report'])
    case 'doctor':
      return doctorCommand(rest)
    case 'config':
      console.log(JSON.stringify(loadProject().config, null, 2))
      return 0
    case undefined:
    case '-h':
    case '--help':
      console.log(usage)
      return command === undefined ? 1 : 0
    default:
      console.error(`harness: unknown command ${command}\n${usage}`)
      return 1
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(`harness: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  },
)

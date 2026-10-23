#!/usr/bin/env node
// The package ships TypeScript sources (no build step: pnpm does not run build scripts of git
// dependencies by default); tsx compiles them on the fly.
import { register } from 'tsx/esm/api'

register()
await import('../src/cli.ts')

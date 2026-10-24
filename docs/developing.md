# Developing the harness

Every project pins a release, so a change here reaches a project only when its pins move. That
keeps an experiment in one project from breaking the others.

## Working on a change

```bash
pnpm install
pnpm check          # typecheck, format:check, unit tests
pnpm schema         # after changing src/config.ts; tests fail while the schema file is stale
pnpm harness:selftest   # prompts, guard and hooks run against this repository (part of check)
```

The plugin hooks (`plugin/hooks/*.mjs`) must stay dependency-free: they run from Claude Code's
plugin cache, which has no `node_modules`. Put logic that needs zod in `src/` and call it through
the project's CLI (`runHarness` in `plugin/hooks/lib.mjs`). Put hook logic that tests need in an
importable module (`guard-rules.mjs`) and keep the entry file thin.

## Trying a change in a project before releasing

From the project:

```bash
pnpm add -D "@eemelinen/harness@link:../harness"   # the CLI now runs from your checkout
claude --plugin-dir ../harness/plugin              # the plugin too, for this session
pnpm harness:doctor                                # warns: the plugin pin and the package differ
```

`--plugin-dir` overrides the installed marketplace plugin of the same name. Edits to skills and
hooks apply after `/reload-plugins`. The driver loads the plugin from the installed package, so a
linked package means driver runs use your checkout as well. Do not commit the `link:` dependency.

## Releasing

Releases are automatic. After CI passes on `main`, [release.yml](../.github/workflows/release.yml)
runs `scripts/release.ts` on the commits since the last `v*` tag:

- **Only shipped changes release.** If no path in `package.json` `files` (`bin`, `src`, `prompts`,
  `plugin`, `schema`, `templates`, `.claude-plugin`) and not `package.json` itself changed, nothing
  is released: docs, tests and state files reach no project.
- **Version.** Every release bumps the patch number. A breaking change (a config key removed or
  renamed, a changed CLI flag) bumps the minor number while the version is 0.x and the major number
  after that; mark it with `!` in the commit subject (`feat(F-012)!: …`) or a `BREAKING CHANGE:`
  footer. Squash merges keep the PR title as the subject, so put the `!` there. Loop PRs never
  carry the `!`, so the script also compares `schema/harness.config.schema.json` with the last
  tag's: a removed key, a newly required key, a changed or dropped default or a removed enum value
  makes the release breaking, and the changelog says which.
- **Changelog.** One `CHANGELOG.md` bullet per commit subject (without its `type(scope):`
  prefix); `docs`, `test`, `ci` and `style` commits are left out. The same lines become the GitHub
  release notes.
- **Commit, tag, push.** The workflow commits `chore: release vX.Y.Z` (version and changelog), tags
  it and pushes both to `main`, then creates the GitHub release. Sessions never bump the version,
  edit the changelog or tag.

**Quarantine.** To keep projects off a bad release, open an issue in this repository labelled
`harness-quarantine` with the version in its title (loops with `update.auto` file one themselves
when a release regresses). Close it as **not planned** to lift it; the fix PR closes it as
completed, which keeps the bad release quarantined.

One-time setup: `main` is protected, so `GITHUB_TOKEN` cannot push the release commit. Create a
fine-grained personal access token with **Contents: read and write** on `Eemelinen/harness`, store it
as the repository secret `RELEASE_TOKEN`, and let it bypass the `main` protection (branch protection:
allow its owner to bypass; a ruleset: add its owner to the bypass list). Without the secret the
checkout fails and nothing is released.

To release by hand (a release that failed, or a change the filter skipped), re-run the workflow
from the Actions tab, or run the same steps locally: `pnpm exec tsx scripts/release.ts`, then
`git push --atomic origin HEAD:main vX.Y.Z`.

**Update each project** to a new release. A project with `update.auto` does it from its loop
before the next feature ([how-it-works.md](how-it-works.md#4-operating-the-loop)). By hand:

- `pnpm harness:update` (or `--to X.Y.Z`): pins the package with
  `pnpm add -D "@eemelinen/harness@github:Eemelinen/harness#vX.Y.Z"`, sets the marketplace `ref`
  in `.claude/settings.json` to `vX.Y.Z` and runs the new version's `harness doctor`
- `pnpm check`
- commit as `chore(harness): update to vX.Y.Z`
- interactive sessions pick the new plugin up after `claude plugin marketplace update eemelinen-harness`
  (or a restart with auto-update on)

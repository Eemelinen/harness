# Session handoff

Compact handoff for the next session. Copy the template into the top of this file (newest
first) and fill every line.

### Handoff — YYYY-MM-DD · session NNN (<feature or topic>) → next: <next step>

#### Verified now

- What is currently working:
- What verification actually ran:

#### Changed this session

- Code or behaviour added:
- Infrastructure or harness changes:

#### Broken or unverified

- Known defect:
- Unverified path:
- Risk for the next session:

#### Next best step

- Highest-priority unfinished feature:
- Why it is next:
- What counts as passing:
- What must not change during that step:

#### Commands

- Startup: `./init.sh` (`FAST=1` to skip the baseline)
- Verification: `pnpm check` · … · `pnpm harness:verify F-NNN`
- Focused debug command:

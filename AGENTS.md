# Repository instructions

## Validation

- Run only tests and checks relevant to the changed behavior or files.
- Do not run the full test or acceptance suite for routine changes, including
  `node scripts/check-local.mjs` and `npm run test:all`. The user will run the
  whole package manually unless they explicitly ask the agent to run it.
- Reuse passing results when the relevant code has not changed. Repeat or expand
  checks only when new changes, failures or unresolved concerns justify it.
- For documentation-only changes, review the diff and relevant links; no
  application tests are needed.
- Report which checks ran accurately. Do not imply the full suite passed when
  only targeted validation was performed.

<!-- postman-cli:installation:start -->
Postman CLI is installed on this device, and can be used for API Engineering work.
<!-- postman-cli:installation:end -->

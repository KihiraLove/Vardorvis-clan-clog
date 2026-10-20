# Repository instructions

## Documentation

- Keep README.md focused on a brief project introduction, badges, installation
  steps, and links that help newcomers navigate the repository and its guides.
  Do not use it as a general documentation holder.
- Put lasting configuration, usage, development and operational instructions in
  the relevant existing guide under docs/. Create a short, focused guide only
  when no existing document fits, and link it from the appropriate navigation.
- Record change summaries, release/version notes, reviews and temporary solutions
  in comments on the current pull request, not in README.md or standing guides.
  Keep any lasting instructions from that work in the relevant docs/ guide.
- Track implementation plans in GitHub issues and reference them from the
  current pull request.

## Live deployments

- Preserve live installations and their data. Apply database changes through new,
  forward-only migrations; never modify an already released migration or baseline.
- Include an upgrade check from the existing schema when changing the database.

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

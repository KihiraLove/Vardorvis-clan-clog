# Contributing

Create a feature branch and PR linked to a development issue. Read [requirements](docs/requirements.md) and [architecture](docs/architecture.md) before implementing business behavior. Keep foundation endpoints honest about unavailable functionality.

Before pushing, run `npm run test:all` with Node 24 and Docker running. This covers the complete automated suite using isolated Linux databases, Chromium and a production Compose stack; see [local acceptance](docs/local-testing.md). Record the tested commit and local results in the PR. Use focused host tests during iteration. Include visual references for collection-log changes. Hosted CI is manual or release-triggered; ordinary PR updates do not consume runner time.

Shared item identities belong in the domain/database packages; do not add separate collected flags to individual pages. Catalog changes need provenance, a reviewed import diff and coverage validation. Approval/revocation must be a transaction with an authenticated actor and audit record.

Never commit `.env`, bot/OAuth/session credentials, production database dumps or private proof data. New environment settings must update `.env.example`, environment docs, validation and Compose as appropriate. Browser bundles must never receive backend secrets.

Never modify a migration already applied to a deployed database. Add a new migration, keep old-image compatibility where possible, and describe backup/recovery implications in the PR. Green foundation checks do not replace feature acceptance criteria.

For dependency PRs, follow the [dependency update policy and review notes](docs/dependency-updates.md). Weekly proposals need stable upstream releases, compatible peers and CI that exercises the changed workflow.

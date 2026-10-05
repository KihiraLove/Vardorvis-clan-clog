# Contributing

Create a feature branch and PR linked to a development issue. Read [requirements](docs/requirements.md) and [architecture](docs/architecture.md) before implementing business behavior. Keep foundation endpoints honest about unavailable functionality.

Use Node 24 and `npm ci`, then run `npm run validate`. Run database integration tests against a separate disposable database. Include visual references for collection-log changes and run the Compose smoke check for runtime/image/configuration changes.

Shared item identities belong in the domain/database packages; do not add separate collected flags to individual pages. Catalog changes need provenance, a reviewed import diff and coverage validation. Approval/revocation must be a transaction with an authenticated actor and audit record.

Never commit `.env`, bot/OAuth/session credentials, production database dumps or private proof data. New environment settings must update `.env.example`, environment docs, validation and Compose as appropriate. Browser bundles must never receive backend secrets.

Never modify a migration already applied to a deployed database. Add a new migration, keep old-image compatibility where possible, and describe backup/recovery implications in the PR. Green foundation checks do not replace feature acceptance criteria.

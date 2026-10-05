# Validation and completion gates

## Foundation checks

```bash
npm ci
npm run validate
docker compose -f compose.yaml -f compose.dev.yaml --profile bot up -d --build --wait
curl --fail http://127.0.0.1:8088/api/v1/status
```

Unit tests cover cross-page collection identity, uncollected defaults, pending/rejected/revoked exclusion, multiple collector credits, canonical mapping validation, proof-host spoofing, calendar dates and Discord command structure. API tests distinguish liveness from migrated-database readiness. The PostgreSQL test applies migrations twice and verifies two pages show one shared item's pending/approved/revoked state consistently.

The integration test explicitly skips without `TEST_DATABASE_URL`; GitHub CI always provisions it. Never use the live database for tests. `npm run typecheck` assumes shared workspaces have been built; `npm run validate` performs builds in dependency order.

Container CI checks all Docker targets, production routing, migrations and health. Images are published only after validation and container smoke tests pass on main. ARM images are built by QEMU; hardware deployment/health on the actual home server still needs a release acceptance check.

## Feature checks to add with implementation

- Catalog: source-revision coverage, categories/pages/slots, deterministic import, icon existence, duplicates and variants, safe additive updates with existing credits.
- Public UI: reference-client screenshot comparisons at the native reference size, tab/page selection, original dim/collected treatment, per-page and global counters, mobile navigation, tooltip viewport handling and keyboard/touch access.
- Intake: invalid evidence, wrong guild/credential, optional-name fallback, exact/ambiguous item matching, idempotent interaction retry, concurrent retries and API timeouts without false success receipts.
- Review: anonymous/non-admin denial, session/CSRF checks, missing item prevents approval, stale versions, double approval races, correction/rejection/revocation audit transactions and final-credit revocation.
- End to end: Discord adapter submission → pending review → approval → public item highlighted on every relevant page with collector/date → revocation removes only that credit.
- Hardcore: default-false claims, approved-only canonical flags on shared pages, red item/menu borders, in-menu skull and exact suffix, mixed credit lines, flag correction and final-hardcore revocation while normal collection remains.
- XP: first competition adds all competitor skill gains to existing totals; repeated unchanged imports add zero; ongoing refreshes apply only differences; new competitions accumulate by skill; name changes retain WOM identity; zero/unavailable rows, multi-skill/overall expansion, exact large totals, concurrent/retried imports, corrected source data and failed refreshes preserve/reconcile correctly.
- XP UI/admin: separate site tab preserves the original log tabs; every competitor is visible; public read/admin-only preview/apply and contribution history work on desktop, keyboard and mobile.
- Operations: cold install, image/configuration updates, health failure, durable database restart, backup/restore rehearsal, compatible image rollback and tested ARM/AMD64 targets.

The visual and end-to-end checks require the actual assets/features; a green foundation CI run alone does not mean the website or bot is complete.

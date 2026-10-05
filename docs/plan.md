# Development plan

The repository foundation is delivered first: workspace/build scaffolds, initial schema/migrations, shared invariants, docs, PR validation, private image publishing and an opt-in deployment workflow. The finished website and live bot are the implementation work below.

Tracking epic: [#15](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/15). Every task has concrete acceptance criteria and explicit blocking issue links. All feature tasks are initially open; do not treat the scaffolds as completed features.

## Issue index

| Issue                                                              | Workstream | Phase                 | Priority | Depends on                               |
| ------------------------------------------------------------------ | ---------- | --------------------- | -------- | ---------------------------------------- |
| [#1](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/1)   | CAT-01     | 1: catalog and reads  | P0       | Foundation                               |
| [#2](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/2)   | API-01     | 1: catalog and reads  | P0       | #1                                       |
| [#3](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/3)   | UI-01      | 1: catalog and reads  | P0       | #1, #2                                   |
| [#4](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/4)   | AUTH-01    | 2: intake and review  | P0       | Foundation                               |
| [#5](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/5)   | INTAKE-01  | 2: intake and review  | P0       | #1                                       |
| [#6](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/6)   | BOT-01     | 2: intake and review  | P0       | #5                                       |
| [#7](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/7)   | REVIEW-01  | 2: intake and review  | P0       | #4, #5                                   |
| [#8](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/8)   | ADMIN-01   | 2: intake and review  | P0       | #4, #7                                   |
| [#9](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/9)   | UI-02      | 3: complete user flow | P0       | #3, #2, #7                               |
| [#10](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/10) | DATA-01    | 3: complete user flow | P1       | #1, #2, #30                              |
| [#11](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/11) | OPS-01     | 3: complete user flow | P0       | #4, #5, #6, #7                           |
| [#12](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/12) | QA-01      | 4: release            | P0       | #6, #8, #9, #11, #26, #27, #28, #30, #31 |
| [#13](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/13) | OPS-02     | 4: release            | P1       | #11, #30                                 |
| [#14](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/14) | DEC-01     | 1: product decisions  | P1       | Foundation                               |
| [#26](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/26) | HC-01      | 3: complete user flow | P0       | #2, #5, #6, #7, #8, #9                   |
| [#27](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/27) | XP-01      | 3: complete user flow | P0       | #4                                       |
| [#28](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/28) | XP-02      | 3: complete user flow | P0       | #4, #27                                  |
| [#30](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/30) | CAT-02     | 3: complete user flow | P0       | #1, #2, #4                               |
| [#31](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/31) | ADMIN-02   | 3: complete user flow | P0       | #4, #8, #30                              |

P0 is on the V1 release path. P1 follows or can run alongside it; recovery acceptance remains required before a real public launch even where automation enhancements are later.

## Delivery order

1. **Catalog and public foundation.** Import a complete versioned catalog and assets (#1), then public read endpoints (#2) and the original collection-log shell (#3). Confirm open product defaults (#14). Auth (#4) can progress independently of catalog work.
2. **Durable intake and review.** Deliver authenticated idempotent intake (#5), then the Discord gateway adapter (#6). Combine auth/intake for review transactions (#7), then the admin queue (#8). No item becomes collected before a real approval.
3. **Connected public behavior.** Add collected highlights/mini menus and refresh behavior (#9), safe catalog updates (#10), and production permissions/configuration/health (#11). Add hardcore collection styling (#26) across intake/review/public display. The XP importer (#27) can proceed after admin auth; its separate page/admin refresh UI (#28) follows the import contract. Deliver admin item/icon storage and versioned page ordering (#30), then the Add item/editor UI (#31); coordinate source refresh preservation/reconciliation with #10.
4. **Release acceptance.** Run the complete end-to-end/visual/accessibility gates (#12) and home release/restore drills (#13). A green foundation build is not a public launch gate by itself.

Critical dependency path: catalog → intake → transactional review → admin/public collection UI → production readiness → end-to-end release. Public layout and admin auth can be developed alongside the intake path once their own dependencies are available.

## Decisions and defaults

- One canonical item shared by multiple pages, never independently collectible page slots.
- Only approved submissions grant credit; all approved collectors retained and sorted by collection date.
- Hardcore credits drive a shared item flag, red item/menu borders, an in-menu skull and the exact suffix `on hardcore worlds`; mixed ordinary/hardcore credit history remains intact.
- An XP gained site tab opens a separate `/xp` page. Admin WOM competition imports add all competitors' valid gained XP to existing skill totals; refreshing a competition reconciles stored contributions so unchanged results add zero.
- Admin Add item requires icon/name/page(s), without an external game ID. One new canonical item starts uncollected on all selected pages; admins save each page's order independently. Manual edits and durable icons survive source refreshes, image upgrades and restores.
- Discord command uses autocomplete/raw text, mandatory item/proof and optional collector name.
- Collection date initially defaults to UTC receipt date, remains distinct from receipt timestamp, and can be corrected by admin.
- The unnamed second command and optional collection-date input stay open in #14.
- Private GHCR images support AMD64 and ARM64; home deploy is manually dispatched for a successful main SHA.
- Final domain/proxy details and source/client reference assets remain release inputs.

## Definition of done

For each issue: implementation and meaningful acceptance tests pass, contracts/docs/environment examples match shipped behavior, and the linked PR passes `validate` and `docker-smoke`. Visual tasks include reference screenshots; data tasks include versioned provenance and coverage; schema tasks include forward-only migrations and recovery implications.

For V1: the full catalog renders uncollected by default; a real durable Discord submission can be resolved/approved by an authenticated admin; the public item updates on all applicable pages and shows the collector/date; invalid evidence, pending claims and unauthorized reviews never grant credit; revocation and multiple collectors remain consistent; hardcore flags/styles update consistently on approval/correction/revocation; admin competition imports show all competitors and accumulate the correct skills without duplicate refresh credit; admins can create items on multiple pages and rearrange one page without losing other orders or existing credits; manual items/icons/order survive source refreshes and coordinated database/icon restores; self-host restart/backup/restore and real hardware checks pass.

## Suggested board columns

Backlog → Ready → In progress → In review → Done, with Blocked marked explicitly. An issue becomes Ready only when its listed dependencies and essential product inputs are satisfied. Keep the epic checklist and this index aligned with actual merged feature behavior; no GitHub Project board has been created by this setup.

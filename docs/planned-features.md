# Planned hardcore, XP and admin catalog features

Status: planned, 2026-10-05. This document extends the foundation plan; it does not implement runtime routes, database fields, the bot extension or new pages. Tracking issues: [HC-01 #26](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/26), [XP-01 #27](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/27), [XP-02 #28](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/28), [CAT-02 #30](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/30), [ADMIN-02 #31](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/31); the [V1 epic #15](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/15) includes them.

## Hardcore collection credits

Store a default-false `hardcore` boolean with each submitted collection claim. Admins inspect proof and can set/correct the flag during review. The planned Discord input adds optional `hardcore`; it is a claim for review, not proof and not a shortcut to approval. No account-type inference is involved: use the actual reviewed collection condition.

The effective item flag is:

```text
hardcoreCollected(item) = any approved credit for this canonical item with hardcore = true
```

This keeps a single canonical item across multiple pages. It also keeps ordinary and hardcore collector history instead of replacing one with the other. Item collection counts still count that item once globally.

| Approved state               | Item border                    | Mini menu                                                | Credit line                                |
| ---------------------------- | ------------------------------ | -------------------------------------------------------- | ------------------------------------------ |
| No approved credit           | Original uncollected treatment | Original menu treatment                                  | No collected claim                         |
| Ordinary credits only        | Original collected treatment   | Original OSRS menu treatment                             | Collected by KihiraVD on 16/10/26          |
| At least one hardcore credit | Red border                     | Red border, skull icon inside                            | Hardcore lines end with on hardcore worlds |
| Mixed ordinary and hardcore  | Red border                     | Red border, skull icon inside; list all approved credits | Suffix applies to hardcore lines only      |

Exact example: **Collected by KihiraVD on 16/10/26 on hardcore worlds**. Keep the skull inside the custom mini menu, with accessible text identifying the hardcore state. Preserve pointer hover, keyboard focus/Escape, touch and viewport-clamping behavior.

A pending/rejected/revoked hardcore claim has no public effect. Revoking or correcting the final approved hardcore credit clears red borders/skull. If an ordinary approved credit remains, the item stays collected with its ordinary collected treatment. Revoking the final approved credit makes the item uncollected.

Implementation must add a new forward migration, shared credit/API fields, versioned audited admin edits and the canonical public projection. Do not alter the already-applied initial migration or add per-page copies of hardcore state. Follow existing idempotency rules, including the flag when comparing intake payloads.

## XP gained page

Add an `XP gained` tab in site navigation and route it to `/xp`. The recreated collection-log window retains its original five tabs. The new page shows each skill's accumulated site XP, member cumulative gains, and competition-specific results with every competitor's gained XP. It also shows skill names/icons, competition title/source/dates and the last successful refresh.

An admin supplies a WOM competition URL. Its participants provide the imported clan competition roster: include all competitors, including valid zero-gain rows. Store participants by stable WOM player ID and update display-name snapshots on later imports. The page is public, while imports and their detailed audit controls require the existing admin session/allowlist and CSRF protection.

These numbers are competition-accumulated gains. The feature does not overwrite the site with player lifetime XP and does not silently fetch individual HiScores accounts or exclude competitors based on an unrelated roster.

## Source adapter and skills

Accept HTTPS links shaped like `https://wiseoldman.net/competitions/<positive-id>`, with an optional trailing slash/query/fragment. Validate exact allowed hosts, reject credentials/unexpected ports, extract the competition ID, then fetch a fixed official API URL. URL variants resolve to the same imported competition identity; user-supplied hosts never become arbitrary server fetch targets.

The verified current WOM contracts expose competition `metrics`, complete `participations`, stable `playerId` and per-metric `deltas[].values.gained`. Map raw individual skill gains to matching site skills. Ignore the weighted `total` delta and competition scores. The older singular metric/progress fields are deprecated and are not the planned adapter's main contract.

Support individual skill and multi-skill competitions. For an overall competition, request an explicit per-skill breakdown through the documented bulk `metrics` preview, using the maintained supported-skill list rather than one request per player. Credit only actual individual skill deltas. If a valid breakdown cannot be obtained, reject the import with a clear reason rather than inventing or redistributing an overall number. Boss/activity/EHP/EHB-only competitions have no supported skill XP; mixed competitions show ignored non-XP metrics in the import summary.

Validate complete participant/metric data and source freshness before applying a snapshot. Known zero is valid. Missing/untracked/sentinel values remain unavailable and visible; they are never cast to invented positive XP. If a previously credited participant/metric disappears or becomes unavailable, surface that reconciliation for admin review rather than silently erasing history. Network failure, malformed/partial responses, source rate limiting and stale apply revisions preserve the last published totals. The adapter reads competition results only; it does not update WOM participants or competitions.

## Accumulation and refresh rules

Store one active contribution per `(competition_id, player_id, skill)`. New site skills start at zero; a later migration carries forward any existing recorded site total as an explicit baseline. The cumulative skill total is baseline plus the sum of stored valid contributions across imported competitions. The member total is the member's matching contribution sum.

First import adds all valid gained XP from all competitors to the relevant current skill totals. Re-importing an unchanged competition adds zero. A refreshed competition updates its stored contributions and changes the totals by `new contribution - previous contribution`, including legitimate corrections. A different competition adds its gains independently. Use a transactional lock/revision check and request idempotency so retries and concurrent imports cannot apply the same snapshot twice.

Example for one skill:

| Action                                              | Stored competition gains   | Change applied | Site skill total |
| --------------------------------------------------- | -------------------------- | -------------- | ---------------- |
| Already recorded site XP                            | None from this competition | —              | 1,000            |
| Import competition A, all competitors sum to 300 XP | A = 300                    | +300           | 1,300            |
| Refresh unchanged A                                 | A = 300                    | 0              | 1,300            |
| Refresh A after another 50 XP                       | A = 350                    | +50            | 1,350            |
| Import competition B with 200 XP                    | A = 350, B = 200           | +200           | 1,550            |

Different competitions can cover overlapping player/skill/time ranges. Show overlapping sources in the preview/history; totals represent the sum of their reported competition contributions, not proof of deduplicated lifetime game XP. Do not claim identical gameplay across different competitions has been deduplicated merely because repeated imports of the same competition are idempotent.

Use PostgreSQL integer totals with adequate capacity and decimal-string API fields where JavaScript safe-integer limits could be exceeded. A contribution is nonnegative valid XP; the reconciliation change can be negative when a reviewed source correction reduces the recorded value.

## Planned storage and admin flow

| Planned entity    | Identity/responsibility                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- |
| XP competitions   | Canonical WOM competition ID, link, title, dates, source timestamps, active revision      |
| XP players        | WOM player ID and current/snapshot display names                                          |
| XP contributions  | Unique competition/player/skill rows with gained XP and source availability               |
| XP import batches | Request key, fetched snapshot/hash, admin actor, expected/new revision and result         |
| XP import audit   | Before/after contributions, corrections/removals/metric changes and applied skill changes |
| XP projections    | Exact cumulative skill/member totals and public read revision                             |

The existing `audit_events` table is submission-specific. Add appropriate XP audit storage in a new migration rather than forcing competition imports into its submission foreign key.

Admin flow: paste competition link → preview the complete competition/skill/member result and contribution changes → apply the validated snapshot. Refreshing a known competition follows the same reconciliation. Display imported/updated/unchanged/failure results accurately, and retain source links/history so admins can inspect totals. Applying uses a short-lived preview token and expected stored revision; stale previews require a fresh fetch.

Public reads use stored results, with pagination/numeric sorting without dropping competitors. A WOM outage therefore does not empty the XP page. Its empty state shows zero tracked skill XP before imports and explains that an admin imports competitions.

## Admin-created items and page ordering

Admins can maintain the catalog when OSRS receives new items. The Add item form has three required inputs:

| Input   | Behavior                                                                          |
| ------- | --------------------------------------------------------------------------------- |
| Icon    | Upload and preview a validated raster icon; retain transparency and pixel clarity |
| Name    | Required nonblank display name                                                    |
| Page(s) | Select one or more existing collection-log pages                                  |

An external OSRS game item ID is optional. Do not add it as a required field. Create one canonical item and all selected page memberships in a transaction, appending to each selected page initially. It starts uncollected and non-hardcore everywhere. Future submissions resolve to its internal ID, and later collection/hardcore credits propagate to all occurrences as they do for imported items. The feature does not create new pages.

The page editor shows every item in saved order and supports drag-and-drop, keyboard-accessible move up/down or position controls, and an explicit Save order action. Moving an item on one page changes only that page's slots: it cannot change other page orders, canonical IDs, collector/date history or hardcore evidence. An admin can leave the initial append order or save a deliberate arrangement.

### Identity and source updates

Separate stable internal item identity from external OSRS game aliases. Manual entries can have no external ID; imported/manual allocation must share a collision-safe namespace, preserving existing IDs. The current foundation domain validator requires a nonempty game-ID list, so #30 includes changing that validation rather than inventing a required ID for the form.

Track source/manual provenance and override metadata for item icons, memberships and page order. Source refreshes retain admin-created entries and their durable icon references. Explicit page order takes precedence over source ordering; new source entries append deterministically without rearranging saved members. If an official source later includes a manual entry, require explicit reconciliation to the existing canonical ID and retain its credits. Do not silently create a second copy or merge equal names: similar names can represent different items.

### Transactional order and refreshed reads

The reorder API receives the full ordered canonical ID list and an expected page revision. It checks an exact permutation of current membership, locks/checks that revision, and applies all slots atomically. Handle the initial unique slot constraint safely during swaps. Both creation/membership updates and order saves advance page revisions; competing or stale requests return 409 and the UI reloads current data rather than silently overwriting it.

Publish a new catalog revision/ETag after successful writes, invalidate bot search caches and include manual entries in public reads, autocomplete and admin matching. No static site rebuild is needed for a new item to appear. Authenticate all writes and record the session actor in catalog audit records separate from the submission-specific audit table. Add metadata/revision/asset/audit fields through new forward-only migrations.

### Durable icons and recovery

Validate bounded PNG/WebP uploads by decoding their content, use generated asset IDs and preview staged assets before item creation. Store published icons in a dedicated volume outside the Docker image/container layer and serve referenced assets through same-origin API URLs. Abandoned uploads are cleaned up; a failed item transaction must not publish a partial catalog entry. Do not fetch arbitrary submitted icon URLs.

Image updates and restarts must preserve this volume. Back up and restore the database and icon files together, including manual identities, page memberships and order overrides. The current foundation Compose/deploy helper has no uploaded-icon volume or backup integration; #30/#11/#13 must implement and rehearse this before launch. [Deployment planning](deployment.md) records the operational requirement.

## Acceptance checks

Hardcore: uncollected/default state; pending/rejected claims; approved red item/menu/skull and exact suffix; shared-page propagation; ordinary/hardcore coexistence; corrected flag; revocation of the last hardcore versus last ordinary credit; accessible hover/focus/touch visuals.

XP: all competitor rows; new competition → correct skill/member totals; unchanged retry → zero change; larger ongoing results → only incremental change; second competition → additive totals; renamed players → stable identity; multi-skill and overall mapping; unavailable/zero data; corrected gains/removed participants; large exact totals; concurrent/retried/stale imports; malformed URL/non-XP competition; unauthorized admin calls; source failure → prior published data retained.

Admin catalog: icon/name/page validation with no required game ID; shared-page creation with uncollected defaults; durable icon serving; autocomplete/manual matching; drag/keyboard order saves; malformed permutations and stale/concurrent revisions; safe slot swaps; unchanged credits and other pages; explicit source/manual reconciliation; manual item/icon/order survival across imports, image updates, restarts and coordinated restores.

## Source references

Checked on 2026-10-05:

- [WOM competition details endpoint and bulk metrics preview](https://docs.wiseoldman.net/api/competitions/competition-endpoints)
- [WOM competition/participation delta structures](https://docs.wiseoldman.net/api/competitions/competition-type-definitions)
- [WOM skill and other metric types](https://docs.wiseoldman.net/api/global-type-definitions)
- [WOM API introduction/rate-limit guidance](https://docs.wiseoldman.net/api)

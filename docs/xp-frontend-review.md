> **Historical record:** This document preserves decisions/review evidence at its recorded revision. Current topology, authentication, implemented features and acceptance are maintained in the [current inventory](current-state.md); older pending-feature statements below are superseded.

# Clan XP frontend review

> **7 October 2026 revision:** [Mockup revision](mockup-revision.md) supersedes earlier combined HC styling, multi-collector, separate XP/member-table and public Admin-link requirements. It documents current preview behavior and outstanding live API work.

XP-02 [#28](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/28) is assigned to KihiraLove and stays open for manual review in draft PR #33. The public page and admin import interface are implemented against the proposed [API contract](contracts.md#frontend-xp-payloads). Live WOM fetching, persistence/reconciliation and admin authentication still require #27/#4. No backend endpoint is added by this frontend work.

## Start and review

```bash
npm ci
npm run build -w @clog/domain
npm run dev:web
```

Open `http://127.0.0.1:5173/xp?preview=1`. The separate **XP gained** navigation preserves all five collection-log tabs. The RuneScape skill panel has three columns, local pixel icons and all 24 skills, including Sailing. Every skill starts at `0.00m` before any competition is imported. Select a skill to see cumulative member XP and imported competition results.

Million labels truncate to two decimals: `12345678` becomes `12.34m`. They always end with lowercase `m`. Hover, keyboard focus or tap reveals the exact `12,345,678 XP`; Escape, blur or an outside tap dismisses the tooltip. Exact values and sorting use integer strings/BigInt, including values beyond JavaScript's safe numeric range. Valid zero gains remain distinct from unavailable snapshots.

Choose **Show sample XP** to review Attack `18.34m`, Fishing `4.40m` and Sailing `7.50m`. Member and competition tables include every sample competitor, support search and numeric/name sorting, and retain valid zero/unavailable rows. Competition details show all imported skills, the WOM source, period and last successful import in UTC. Site totals are recorded competition gains, not a player's current in-game XP; overlapping competitions may count the same gameplay more than once.

## Admin preview and refresh

Navigate through **Admin → XP imports** or the bottom import link, keeping preview mode enabled:

1. At `/admin/xp?preview=1`, enter `https://wiseoldman.net/competitions/1001` (Attack) or `https://wiseoldman.net/competitions/1002` (Fishing/Sailing).
2. Preview the complete competitor rows and each skill's recorded-before, after-refresh and change values. Previewing adds no credit.
3. Apply the import and inspect the public totals and audit history.
4. Preview/apply the same competition again: it reports unchanged and adds zero.
5. Choose **Advance sample Attack results**, then preview/apply 1001 again. Only `1,250,000` new XP is added; Attack becomes `19.59m`, exact `19,595,678`.

The sample ledger is in memory only. It stays available across site navigation, resets on reload or leaving preview mode, and never calls WOM or writes to the backend. Sample competition IDs are fixtures, not claims about real WOM events.

Live mode uses same-origin API reads with independent ETags, visible polling every 25 seconds and refresh on tab return. All selected responses must agree on one projection revision. Failed, malformed, aborted or inconsistent reads preserve the last successful dataset and ETags. An initial unavailable service shows dashes/error text, with an explicit preview option; sample XP is never substituted.

Live admin access comes from the server session. Anonymous/forbidden users cannot see the import form; the backend must enforce the same authorization on every write. Only canonical HTTPS WOM competition links are accepted. Preview/apply requests carry CSRF, and apply retries keep one idempotency key. Stale previews/conflicts require a fresh preview, expired tokens cannot apply, and negative corrections require an explicit acknowledgment. Successful imports refresh public data and history; a history read failure does not falsely report that an applied import failed.

## Assets and validation

The [24 skill icons](../apps/web/public/skills/provenance.json) come from RuneLite commit `ddd0669ef4d7494fd420cb507e3c1fa62bab8023`, directory [skill_icons](https://github.com/runelite/runelite/tree/ddd0669ef4d7494fd420cb507e3c1fa62bab8023/runelite-client/src/main/resources/skill_icons). The manifest records each source blob and SHA-256; the [BSD notice](../apps/web/public/skills/LICENSE.txt) is retained. Game sprites are copyright Jagex. Runtime rendering uses local assets and the existing local RuneScape font.

```bash
npm run validate
npx playwright install chromium
npm run test:e2e -w @clog/web
```

Node tests cover exact formatting, input/payload validation, conditional snapshots, revision consistency, aborted reads, CSRF/idempotency request shapes and sample-ledger reconciliation. Six additional Chromium scenarios cover skills/icons, keyboard/hover/touch, a 320-pixel mobile viewport, member/competitor search, initial/unchanged/incremental/multi-skill imports, live failures/recovery, authorization, negative corrections and stale previews. Existing collection-log scenarios remain in the same suite.

CI uploads `xp-desktop.png`, `xp-mobile.png` and `xp-admin.png` in the `frontend-browser-review` artifact, alongside collection-log captures and any failure traces. These are review captures, not approved pixel baselines. Real WOM imports, database concurrency/corrections, rename reconciliation, OAuth/CSRF enforcement and live end-to-end acceptance remain backend/integration work. No task is closed automatically.

The shared admin navigation now links Submissions, Items catalog and XP imports. Preview sign-out in the submission/catalog area also denies the XP import form for that SPA session; reloading starts a fresh signed-in sample session. See the [admin review guide](admin-frontend-review.md) for the related frontend work in #8/#31.

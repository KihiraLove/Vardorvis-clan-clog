# Wise Old Man competitions

In **Scheduling and Competitions**, paste a canonical WOM competition link,
preview it, inspect the changes and apply. Administrators and moderators can
import. WOM's metrics determine SKILL or ACTIVITY; a saved identity cannot
silently change kind or supported scope.

| Kind and state                 | Saved result                    | Page window              |
| ------------------------------ | ------------------------------- | ------------------------ |
| SKILL/computed, future/running | Metadata with unavailable gains | None                     |
| ACTIVITY, future               | Metadata                        | Source start to end      |
| ACTIVITY, running              | Metadata                        | Apply time to source end |
| Either, finished               | Validated final results         | None created             |

The DB clock sets boundaries. Imports never turn on scheduling. Boss/activity pages
are suggested from the union of all selected metrics, without duplicates; inspect
or correct them before applying. Computed competitions do not require page windows.
Ambiguous metrics require explicit pages. Re-importing preserves existing
staff-edited windows and deliberate deletions. Hardcore pages stay fully open.

Imports support multiple skills, bosses, activities and computed EHP/EHB metrics,
including metric weights. WOM requires every selected metric to share a type;
unknown metrics and mixed types are rejected. Overall expands into the 24 canonical
skills without counting raw XP twice, including when a skill is also selected.
Live participant data is discarded for metadata-only imports.

**The Fractured Archive** uses WOM's `the_fractured_archive` metric and imports
as ACTIVITY with kill-count results. An active catalog page with that ID is
suggested automatically. If your catalog predates the raid, create its page/items
in **Items catalog** and select the page explicitly in the competition preview.
Finished results can be imported without a matching catalog page.

Standalone **EHP** and **EHB** competitions use the same preview/apply flow.
Future/running imports store metadata; finished imports retain decimal hours and
WOM's ranked results. They create no skill-XP contribution or page window and
do not change hardcore collections. Computed results have no dedicated public
tracker or leaderboard.

Metric definitions and weights appear in the preview and public competition scope.
Finished previews retain individual metric gains and WOM's combined score. Selected
XP competition podiums use those standings; the Total podium and XP skill totals
use actual unweighted XP. Computed hours and weighted scores never become skill XP.
Scores and weights use decimal strings; ordinary counters and raw XP remain integers.

Finished imports retain stable player IDs and exact gains. Zero-score
participants are excluded after validation. Refresh replaces the competition's
previous contribution, so repeated imports cannot add XP twice. Negative XP
corrections need acknowledgement. Failed imports preserve published data.
Overlapping events count their reported contributions, not deduplicated lifetime XP.

Preview tokens expire, bind staff and revisions, and need refreshing if a
metadata-only event finishes before apply. Request-key replay retains the saved
receipt even after expiry. Review the preview again after a conflict.

The public collection log (`/`) shows stored activity scope/metadata; the XP
tracker (`/xp`) shows skill XP and podiums. Full activity standings and metric
breakdowns are available in the staff preview.
It never queries WOM directly. XP is hidden in hardcore mode. Up to 2,000 current
competitions and 2,000 all-time XP contributions are supported; archive ended
metadata to free current slots, without erasing earned XP. See [maintenance](maintenance.md).

WOM references: [competition API](https://docs.wiseoldman.net/api/competitions/competition-endpoints)
and [metric definitions](https://docs.wiseoldman.net/api/global-type-definitions).

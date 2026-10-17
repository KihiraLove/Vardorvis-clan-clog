# Wise Old Man competitions

In **Scheduling and Competitions**, paste a canonical WOM competition link,
preview it, inspect the changes and apply. Administrators and moderators can
import. WOM's metrics determine SKILL or ACTIVITY; a saved identity cannot
silently change kind or supported scope.

| Kind and state        | Saved result                    | Page window              |
| --------------------- | ------------------------------- | ------------------------ |
| SKILL, future/running | Metadata with unavailable gains | None                     |
| ACTIVITY, future      | Metadata                        | Source start to end      |
| ACTIVITY, running     | Metadata                        | Apply time to source end |
| Either, finished      | Validated final results         | None created             |

The DB clock sets boundaries. Imports never turn on scheduling. Activity pages
are suggested from the metric; inspect or correct them before applying.
Ambiguous metrics require explicit pages. Re-importing preserves existing
staff-edited windows and deliberate deletions. Hardcore pages stay fully open.

SKILL supports individual/multiple skills and overall, expanded into the 24
canonical skills without counting aggregate XP twice. Unsupported mixed scopes,
weighted/multiple activities, EHP/EHB and invalid/partial results are rejected.
Live participant data is discarded for metadata-only imports.

Finished imports retain stable player IDs and exact integer gains. Zero-gain
participants are excluded after validation. Refresh replaces the competition's
previous contribution, so repeated imports cannot add XP twice. Negative XP
corrections need acknowledgement. Failed imports preserve published data.
Overlapping events count their reported contributions, not deduplicated lifetime XP.

Preview tokens expire, bind staff and revisions, and need refreshing if a
metadata-only event finishes before apply. Request-key replay retains the saved
receipt even after expiry. Review the preview again after a conflict.

The public regular log shows stored activity metadata and skill XP/podiums.
It never queries WOM directly. XP is hidden in hardcore mode. Up to 2,000 current
competitions and 2,000 all-time XP contributions are supported; archive ended
metadata to free current slots, without erasing earned XP. See [maintenance](maintenance.md).

WOM references: [competition API](https://docs.wiseoldman.net/api/competitions/competition-endpoints)
and [metric definitions](https://docs.wiseoldman.net/api/global-type-definitions).

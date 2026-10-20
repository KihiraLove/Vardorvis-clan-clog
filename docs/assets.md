# Assets and attribution

The site serves its item icons, skill icons, fonts, frame, default logo and
favicons locally. Uploaded icons/branding use durable server storage; screenshots
are private. All bundled and stored images use WebP. PNG uploads are decoded and
converted losslessly before storage; original PNGs are not saved. Icons retain
their native dimensions and transparency, and screenshots retain readable text.
Source/WOM links may point elsewhere, but rendering does not depend
on third-party image hosting. Discord submissions require a PNG attachment;
RuneLite and staff can also upload screenshots directly. External proof links
are no longer accepted.

- [Catalog provenance](../catalog/provenance.json) and [asset manifest](../catalog/assets.json)
  identify pinned TempleOSRS, OSRS Wiki and RuneLite inputs, hashes and dimensions.
  Image entries distinguish the original input hash (`sourceSha256`) from the
  bundled WebP hash (`sha256`). `npm run catalog:assets` restores pinned artwork
  as WebP; upstream PNGs are converted in memory.
- [Skill icon provenance](../apps/web/public/skills/provenance.json) and bundled
  license record the RuneLite skill artwork.
- [Font license](../apps/web/public/fonts/LICENSE.txt) applies to the bundled font.
- [GitHub mark license](../apps/web/public/brand/github-mark.LICENSE.txt) applies
  to the local Octicons mark.
- The default “Your Clan” logo is a neutral placeholder; replace it in Site
  settings. OSRS names and game artwork remain the property of their owners.

Project code uses the [MIT license](../LICENSE); it does not relicense third-party
assets or imply endorsement by Jagex. Preserve source/license files when replacing
art. New assets should be local, necessary, and include attribution and hashes
where the existing manifest requires them. Build-time catalog checks catch missing
or altered pinned assets. Outdated review screenshots are not shipped.

New catalog artwork uses the [release update manifest](catalog-import.md#release-updates).
The original asset manifest and bytes stay pinned; a new image gets a new hash.
The installer retains selected legacy and supplied images in PostgreSQL, served
at immutable hash URLs. The Fractured Archive's 17 native icons and their exact
source/delivered-byte hashes are recorded in its
[artwork provenance](../catalog/updates/2026-10-20-fractured-archive.provenance.json).
Lossless WebP conversion preserves native dimensions and transparency.
Replacing a hosted item's image requires the administrator's
review unless it is a newly inserted item. Retaining a custom icon does not delete
its uploaded bytes, and normal database backups include the retained bundled bytes.

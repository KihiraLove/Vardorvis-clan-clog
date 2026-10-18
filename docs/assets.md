# Assets and attribution

The site serves its item icons, skill icons, fonts, frame, default logo and
favicons locally. Uploaded icons/branding use durable server storage; screenshots
are private. Source/WOM links may point elsewhere, but rendering does not depend
on third-party image hosting. External Imgur evidence remains a submitted proof
link; RuneLite can upload the screenshot directly.

- [Catalog provenance](../catalog/provenance.json) and [asset manifest](../catalog/assets.json)
  identify pinned TempleOSRS, OSRS Wiki and RuneLite inputs, hashes and dimensions.
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

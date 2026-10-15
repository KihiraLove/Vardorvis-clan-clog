# Reviewed browser references

These synthetic real-stack captures were visually reviewed on 15 October 2026.
The [acceptance policy](../browser-acceptance.md) defines supported engines,
semantic assertions, artifact paths and update rules. The [manifest](manifest.json)
records hashes, environment and geometry. Capture calls wrote only test-specific
output paths; these reviewed copies are maintained separately. Tests do not
automatically update reference images.

- [Desktop public](real-public-desktop.png) and [320px public](real-public-320.png):
  one canonical credit; activity aligns with the desktop frame and stacks on mobile.
  The game window intentionally scrolls internally at 320px.
- [Desktop catalog](real-catalog-desktop.png) and [320px catalog](real-catalog-320.png):
  equal desktop panel edges, expanded picker, stacked mobile panels and visible focus.

Native focus/caret, dates and populated activity/XP fixtures can differ in later
runs. Evaluate semantic results and new captures together; these are reviewed
structural references, not pixel-diff golden files. No production data is included.

# keel brand assets

The mark is the front view of a hull with its keel, split down the middle. A keel is the part
of a ship you do not see. It keeps the ship upright and on course. keel does the same for an
AI coding agent.

## Files

| File | Use |
|---|---|
| `keel-mark.svg` | the symbol, accent on light backgrounds |
| `keel-mark-dark.svg` | the symbol, accent on dark backgrounds |
| `keel-mark-black.svg`, `keel-mark-white.svg` | one-colour symbol |
| `keel-mark-auto.svg` | follows the system light/dark setting (favicons, embeds) |
| `keel-wordmark.svg`, `keel-wordmark-white.svg` | `KEEL` alone |
| `keel-lockup.svg`, `keel-lockup-dark.svg` | symbol + `KEEL`, on light / on dark |
| `keel-lockup-black.svg`, `keel-lockup-white.svg` | one-colour lockup |
| `keel-lockup-lowercase.svg` | the alternate lowercase lockup |
| `png/keel-mark-{16…512}.png` | the symbol on a transparent square |
| `png/keel-icon-{light,dark}-{128,512}.png` | rounded-square app icons |
| `png/keel-lockup{,-dark}.png` | 1200px lockups for places that take no SVG |
| `png/keel-social.png` | GitHub social preview, 1280×640 (Settings → General → Social preview) |

The dashboard carries its own inline copy of the mark (`mcp/ui.js`), because the page has no
build step and loads nothing from disk. Change the shape in both places.

## Colours

| | Light | Dark |
|---|---|---|
| accent | `#7a5cff` | `#a48bff` |
| ink | `#131314` | `#f7f6f3` |
| paper | `#f7f6f3` | `#131314` |

These are the dashboard's own tokens, so the logo and the product match.

## Type

The wordmark is JetBrains Mono ExtraBold, set in capitals with wide spacing. The lowercase
alternate uses JetBrains Mono Bold. Both are converted to outlines, so the SVGs do not need the font
installed. JetBrains Mono is under the SIL Open Font License 1.1.

## Rules

- Leave clear space around the mark of at least the height of its fin.
- Keep the split. At 16px it disappears on its own; do not draw a separate small version.
- Do not recolour the mark outside the accent / ink / white set, add gradients, rotate it, or
  put it on a busy photo.

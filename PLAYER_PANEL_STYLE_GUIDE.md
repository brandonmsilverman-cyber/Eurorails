# Player Panel Styling Guide

Design reference for the sidebar player cards and actions panel indicators in `public/eurorails.html`. All styling lives in the `updateUI()` function as inline styles on dynamically generated HTML.

---

## Active Player Card

The active player card uses the `.player-info.active` CSS class:

| Property | Value |
|---|---|
| Background | `#444` |
| Padding | 8px |
| Border radius | 3px |
| Left border | 3px solid `#4a9eff` |

### Row 1: Player Name + Phase Badge

Flex row with `justify-content: space-between` and `align-items: center`. Bottom margin 6px.

**Player name (left):**

| Property | Value |
|---|---|
| Element | `<strong>` |
| Font size | 14px |
| Color | Player's assigned color via `COLOR_MAP[p.color]` |

**Phase badge (right):**

Pill-shaped badge indicating the current turn phase.

| Property | Value |
|---|---|
| Font size | 10px |
| Font weight | Bold |
| Text transform | Uppercase |
| Letter spacing | 0.5px |
| Padding | 2px 8px |
| Border radius | 10px (fully rounded pill) |
| Border | 1px solid `{phaseColor}` |
| Background | `{phaseColor}22` (phase color at ~13% opacity via hex alpha) |
| Text color | `{phaseColor}` (matches border) |

Phase-specific values:

| Phase | Icon | Display Text | Color |
|---|---|---|---|
| Initial Building | U+1F528 `🔨` | `🔨 INITIAL BUILDING` | `#ff8800` (orange) |
| Operate | U+1F682 `🚂` | `🚂 OPERATE` | `#4a9e4a` (green) |
| Build | U+1F527 `🔧` | `🔧 BUILD` | `#4a7aff` (blue) |

The icon is placed inline before the text with a space separator. The uppercase transform is applied via CSS `text-transform`, so the source text is title case.

### Row 2: Cash + Train Type + Cities

Dark container row holding the ECU balance, train type, and cities count.

**Container:**

| Property | Value |
|---|---|
| Background | `#1a1a2e` (dark navy) |
| Padding | 6px 8px |
| Border radius | 4px |
| Border | 1px solid `#333` |
| Layout | Flex, `justify-content: space-between`, `align-items: center` |

**Cash (left side):**

| Property | Value |
|---|---|
| Format | `ECU {amount}M` |
| Font size | 16px |
| Font weight | Bold |
| Color | `#ffd700` (gold) |

**Train Type (center):**

| Property | Value |
|---|---|
| Format | `{trainType}` (e.g., "Freight", "Fast Freight", "Heavy Freight", "Superfreight") |
| Font size | 11px |
| Color | `#aaa` |

**Cities (right side):**

| Property | Value |
|---|---|
| Format | `Cities: {count}/7` |
| Label font size | 11px |
| Label color | Inherited (default `#ccc`) |
| Count font weight | Bold |
| Count color | `#4a9e4a` (green) if `count >= 7`, otherwise `#ff8800` (orange) |

---

## Inactive Player Cards

Single-line layout using the `.player-info` CSS class (no `.active`):

| Property | Value |
|---|---|
| Margin bottom | 8px |
| Font size | 13px |

Flex row with `justify-content: space-between` and `align-items: center`.

**Player name (left):**

| Property | Value |
|---|---|
| Element | `<strong>` |
| Font size | 13px (inherited) |
| Color | Player's assigned color via `COLOR_MAP[p.color]` |

**Stats (right side):**

| Property | Value |
|---|---|
| Format | `ECU {amount}M \| {trainType} \| {count}/7 Cities` |
| Overall font size | 11px |
| Cash color | `#ffd700` (gold) |
| Cash font weight | Bold |
| Cities count color | `#4a9e4a` (green) if `>= 7`, else `#ff8800` (orange) |
| Cities count font weight | Bold |
| Train type color | `#aaa` |
| Separator | ` \| ` (pipe with spaces, default text color) |

---

## Movement Progress Bar (Operate Actions Panel)

Displayed at the top of the actions panel during the operate phase, above the "Click along your track to move train" tooltip. Matches the build budget bar styling.

### Text Row

Flex row with `justify-content: space-between`. Bottom margin 4px.

| Property | Value |
|---|---|
| Label (left) | `Movement:` |
| Label color | Inherited (default `#ccc`) |
| Value (right) | `{remaining} / {max} mp` |
| Value element | `<strong>` |
| Value color | Dynamic (see color thresholds below) |
| Half-speed suffix | ` ⚠ half` (U+26A0 warning sign) appended when in half-speed zone |
| Font size | 11px (inherited from parent div) |

**Max movement:** Sourced from `TRAIN_TYPES[trainType].movement`. When in a half-speed zone, effective max is `Math.floor(maxMovement / 2)`.

### Progress Bar

| Property | Value |
|---|---|
| Track background | `#333` |
| Track height | 8px |
| Track border radius | 3px |
| Track overflow | Hidden |
| Fill width | `{remaining / effectiveMax * 100}%` |
| Fill color | Dynamic (see color thresholds below) |
| Fill transition | `width 0.3s` |

### Color Thresholds

Both the text value and progress bar fill use the same color:

| Condition | Color |
|---|---|
| Remaining > 50% of max | `#4a9eff` (blue) |
| Remaining > 20% of max | `#ffcc00` (yellow) |
| Remaining <= 20% of max | `#ff4444` (red) |

---

## Build Budget Bar (Build/Initial Building Actions Panel)

Existing design, included here for reference. The movement bar was designed to match this pattern.

### Text Row

Flex row with `justify-content: space-between`. Bottom margin 4px.

| Property | Value |
|---|---|
| Label (left) | `Turn Budget:` |
| Value (right) | `{remaining}M / 20M` |
| Value element | `<strong>` |
| Value color | Dynamic (see below) |
| Font size | 11px (inherited) |

### Progress Bar

| Property | Value |
|---|---|
| Track background | `#333` |
| Track height | 8px |
| Track border radius | 3px |
| Track overflow | Hidden |
| Fill width | `{remaining / 20 * 100}%` |
| Fill color | Dynamic (see below) |
| Fill transition | `width 0.3s` |

### Color Thresholds

| Condition | Color |
|---|---|
| Remaining > 10M | `#4a9e4a` (green) |
| Remaining > 5M | `#ffcc00` (yellow) |
| Remaining <= 5M | `#ff4444` (red) |

---

## Layout Order in Actions Panel

Both build and operate phases follow the same ordering convention:

1. Progress bar (budget or movement)
2. Instruction tooltip ("Click two mileposts..." or "Click along your track...")
3. Phase-specific controls (path mode buttons, trackage rights toggle, etc.)

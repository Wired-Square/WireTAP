# WireTAP Frontend Style Guide

This guide describes how UI is built in WireTAP — the theme and its
vocabulary, the primitives and where each goes, how to localise strings and
how to register a new app. It is the canonical reference for the frontend;
if a question is not answered here, prefer reading the source in
[../frontend/wiretap-ui/src/styles/](../frontend/wiretap-ui/src/styles/) and
[../frontend/wiretap-ui/src/components/](../frontend/wiretap-ui/src/components/)
over inventing a new pattern.

## Overview

All visual styling is centralised in [../frontend/wiretap-ui/src/styles/](../frontend/wiretap-ui/src/styles/). The
public surface is the barrel file [../frontend/wiretap-ui/src/styles/index.ts](../frontend/wiretap-ui/src/styles/index.ts) —
import tokens from there:

```tsx
import { textPrimary, spaceYDefault, h2 } from "../../../styles";
import { Button, IconButton } from "../../../components/Button";
```

Buttons, form controls, badges, cards, alerts, dialogs, tabs, menus and
tables are components, not class strings — see *Buttons*, *Inputs*,
*Badges*, *Cards & alerts*, *Dialogs*, *Tabs*, *Menus* and *Data tables*
under the token reference.

Localisation lives in [../frontend/wiretap-ui/src/locales/](../frontend/wiretap-ui/src/locales/). The active language
is driven by the `language` field in `settings.json` (see
[../frontend/wiretap-ui/src/apps/settings/stores/settingsStore.ts](../frontend/wiretap-ui/src/apps/settings/stores/settingsStore.ts)).
The bootstrap is [../frontend/wiretap-ui/src/i18n.ts](../frontend/wiretap-ui/src/i18n.ts), imported once for side
effects from [../frontend/wiretap-ui/src/main.tsx](../frontend/wiretap-ui/src/main.tsx).

## Core principles

These are non-negotiable in this codebase:

1. **A colour is one of the theme's, named for what it means.** Every colour
   utility reads a `:root` variable that `useTheme` sets, so one variable
   change re-themes every use. There is no palette: `text-red-500`,
   `bg-slate-900/50` and `bg-[#0b0f14]` all fail generation. Error text is
   `text-danger`, a hint `text-muted`, a live dot `bg-success-text`, a glyph
   in a hue `text-purple` — the status tones say what state a thing is in,
   the data accents which of several things it is (see *Theming model*).
2. **Australian English** in all UI strings, comments, identifiers. "Colour",
   "centralised", "organisation". Project-wide rule from
   [../CLAUDE.md](../CLAUDE.md).
3. **Every user-facing string goes through `t(…)`.** No JSX text literals.
4. **A button is `<Button>` or `<IconButton>`; a form control is `<Input>`,
   `<Select>`, `<Textarea>`, `<Checkbox>` or `<Radio>`.** The primitive carries
   the look (`variant`, `tone`, `size`, `pressed`) and the wiring
   (`type="button"`, `aria-pressed`, `aria-label`, the select's chevron); a raw
   `<button>` is for the families that have no primitive yet — list rows, menu
   items, tabs, cards — and a raw `<input>` is a colour swatch, a range
   slider or an inline rename field.
5. **The primitive carries the state, not the call site.** A button's hover,
   press and disabled looks, an input's focus ring, a card's lift, a menu
   row's highlight are rules in `components.css`; a consumer never re-draws
   them. The one hover a raw element draws is `hoverBg` (`hover:bg-hover`)
   on a list row that has no primitive yet.

## Theming model

There is no CSS framework. [WireTAP.css](../frontend/wiretap-ui/src/WireTAP.css)
declares three layers and imports the app's own sheets into them, in cascade
order:

- [reset.css](../frontend/wiretap-ui/src/styles/reset.css) — the browser
  reset, `@layer reset`.
- [components.css](../frontend/wiretap-ui/src/styles/components.css) — the
  semantic classes the primitives render (`.btn`, `.input`, `.select`,
  `.check` and their modifiers), `@layer components`. Below the utilities on
  purpose: a `className` on a `<Button>` or `<Input>` still wins.
- [utilities.css](../frontend/wiretap-ui/src/styles/utilities.css) — every
  utility class the code uses, `@layer utilities`. It is **generated**:
  `npm run gen:css` scans the class strings under `src/` and writes the sheet,
  and the `utilitiesCss` test fails until the committed sheet matches. A class
  the generator cannot resolve, or a variant it does not have (`dark:`, `md:`,
  `[&…]:`), fails the run rather than silently emitting nothing — a typo in a
  class name is a test failure, not a missing rule.
- The rest of `WireTAP.css` — theme variables, fonts and the app's own rules —
  is unlayered, so it wins over both.

The two typefaces are variables on `:root`: `--font-sans` (the system UI
stack) and `--font-mono` (JetBrains Mono, bundled, over the platform's
monospace). `font-mono`, the reset's `code` / `pre` rule and the tables'
`mono` all read `--font-mono`, so the app has one data face and a `ch` in
a column width means the same on macOS and Windows.

The theme is one `:root` block in `WireTAP.css` (light) and one `.dark`
block (dark) — surfaces, text, borders, the four user-settable accents, six
status sets of `bg` / `text` / `border`, thirteen data accents and the
BitPreview signal colours. `useTheme`
([../frontend/wiretap-ui/src/hooks/useTheme.ts](../frontend/wiretap-ui/src/hooks/useTheme.ts))
toggles `.dark` on `<html>` and overrides the eleven user-settable variables
inline from the `theme_*` settings.

**Every theme variable is a colour utility by name.** The generator reads the
`:root` block and names each variable in the `text-`, `bg-` and `border-`
families (and the families that share their role: `fill-`, `stroke-`,
`placeholder-`, `decoration-` and `accent-` with text; `from-` / `to-` with
bg; `divide-`, `ring-` and `outline-` with border). The class value is the
variable minus `--` and `status-`, and minus the family's own role where the
name carries one:

| Variable | text | bg | border |
|---|---|---|---|
| `--text-muted` | `text-muted` | `bg-text-muted` | `border-text-muted` |
| `--bg-surface` | — | `bg-surface` | — |
| `--border-default` | — | `bg-border-default` | `border-default` |
| `--status-info-text` | `text-info` | `bg-info-text` | `border-info-text` |
| `--status-info-bg` | — | `bg-info` | — |
| `--status-info-border` | — | `bg-info-border` | `border-info` |
| `--text-amber` (data accent) | `text-amber` | `bg-text-amber` | `border-text-amber` |
| `--accent-primary` | `text-accent-primary` | `bg-accent-primary` | `border-accent-primary` |
| `--bg-hover` | — | `bg-hover`, `hover:bg-hover` | — |

So a dot painted in the info colour is `bg-info-text`, a hairline drawn as a
`div` is `bg-border-default`, a tinted shadow `shadow-accent-danger/30`
(`shadow-` colours share the bg role), and `text-purple` is always the
purple data accent (the purple and cyan tones' text reads it too). An alpha
works as on any colour: `text-accent-primary/70`. Adding a variable to
`WireTAP.css` adds its utilities — one declaration per line, the way the
block is written, because the generator (and the guard) reads `^--name:`.
A name two variables would share fails generation.

Those are the only colours. The palette is gone from the generator and an
arbitrary colour (`bg-[#0b0f14]`) is refused with it, so a colour the theme
lacks is a variable to add, not a class to spell; a value that is genuinely
one element's own (the terminal's xterm background) is a `style` prop named
once. Five named colours remain — `transparent`, `current`, `inherit`, and
`white` and `black` for what is the same in both themes: the tick on a
filled checkbox, the knob on a switch, the bit number on a signal's colour,
the logo's tile, a scroll-edge shadow. `text-white` is never a way to put
text on a tone's fill — that is `<Button variant="solid">`, whose text is
the fill's own.

The tokens in [colourTokens.ts](../frontend/wiretap-ui/src/styles/colourTokens.ts)
name the common ones (`textPrimary = "text-primary"`, `bgSurface =
"bg-surface"`); the class and the token are interchangeable.

**Which colour a site means.** The status tones (`success`, `danger`,
`warning`, `info`) say what state something is in: a session running,
stopped, paused or failed; a probe that succeeded; a required field's mark;
a value that is missing; a duplicate; the "on" of a toggle in the primary
accent. The data accents (`--text-<hue>`) say which of several things it is:
a bus number is cyan, a source address purple, a checksum amber, a frame id
green, a section glyph its section's hue — and a source's kind is a named
set, `sourceKindColours` (realtime purple, capture cyan, recorded green),
read wherever a source is drawn. A spinner or a selected edge is the primary
accent (`text-accent-primary`, `border-accent-primary`); a selected row is
the info tint (`bg-info border-info`) or its kind's `tint`.

The class vocabulary is Tailwind 4's, kept when the framework was removed so no
component had to change. The old rule that `dark:` variants "don't work on
Windows WebView" was never a WebView limit: Tailwind's `dark:` compiled to
`@media (prefers-color-scheme: dark)` because no `@custom-variant dark` pointed
it at the app's `.dark` class, so it diverged whenever the OS and the app
setting disagreed. The generator rejects `dark:` outright; theme-dependent
styling goes through the variables.

## Token reference

### Colours — [colourTokens.ts](../frontend/wiretap-ui/src/styles/colourTokens.ts)

| Token | Class | Use |
|---|---|---|
| `bgPrimary` | `bg-primary` | App background |
| `bgSurface` | `bg-surface` | Dialogs, panels, cards, toolbars |
| `bgDataView` | `bg-data` | Data table background |
| `textPrimary` | `text-primary` | Headings, main content |
| `textSecondary` | `text-secondary` | Descriptions, labels, data-view secondary text |
| `textMuted` | `text-muted` | Disabled, placeholder |
| `textDataPrimary` | `text-data-primary` | Text inside data views |
| `textDataTertiary` / `-Muted` / `-Disabled` | `text-secondary opacity-80` / `-60` / `text-muted opacity-50` | Reduced emphasis in data views; `-Disabled` pairs with a themed accent for inactive state |
| `borderDefault` | `border-default` | Default border |
| `borderDivider` | `border-b border-default` | Section separators |
| `bgSuccess` / `bgDanger` / `bgInfo` | `bg-success` / `bg-danger` / `bg-info` | Status tints (`bg-warning`, `bg-purple`, `bg-cyan` written out) |
| `textSuccess` / `textDanger` / `textWarning` / `textInfo` | `text-success` … | Status text |
| `borderSuccess` / `borderDanger` | `border-success` / `border-danger` | Status borders (`border-warning`, `border-info`, `border-purple`, `border-cyan` written out) |
| `textDataGreen` / `-Yellow` / `-Orange` / `-Purple` / `-Amber` / `-Cyan` | `text-green` … | Cell / syntax highlighting; the other data accents (`text-red`, `text-blue`, `text-pink`, `text-sky`, `text-indigo`, `text-teal`, `text-emerald`) written out |
| `sourceKindColours[kind]` | `.text` / `.dot` / `.edge` / `.hoverEdge` / `.tint` | The hue a source wears — `realtime` purple, `capture` cyan, `recorded` green — on the picker's rows, the session canvas and the session button |
| `hoverBg` / `hoverLight` | `hover:bg-hover` / `hover:brightness-95` | Hover states |
| `dataViewContainer` | `rounded-lg border border-default overflow-hidden` | Standard data "bubble" |

### Typography — [typography.ts](../frontend/wiretap-ui/src/styles/typography.ts)

| Token | Use |
|---|---|
| `h1` / `h2` / `h3` / `h4` | Heading levels |
| `bodyDefault` / `bodySmall` | Body text |
| `mono` / `monoBody` | Code / monospace |
| `caption` / `captionMuted` | Captions |
| `emphasis` / `textMedium` | Inline emphasis |
| `labelSmall` / `labelSmallMuted` / `sectionHeader` / `sectionHeaderText` | Labels and section headers |
| `truncate` | Truncation |
| `emptyStateContainer` / `emptyStateText` / `emptyStateHeading` / `emptyStateDescription` / `emptyStateHint` | "No data" / "Not connected" displays |

### Spacing — [spacing.ts](../frontend/wiretap-ui/src/styles/spacing.ts)

| Token | Class | Use |
|---|---|---|
| `paddingAppBarX` / `marginAppContent` | `px-4` / `m-2` | App-bar / panel chrome |
| `roundedDefault` | `rounded-lg` | Panel radius |
| `sectionDivider` | `pt-4 border-t border-default` | Titled-section divider |
| `gapSmall` / `gapDefault` | `gap-2` / `gap-4` | Flex/grid gaps |
| `spaceYTight` / `-Small` / `-Default` / `-Large` | `space-y-1`/`-2`/`-4`/`-6` | Vertical spacing |
| `iconXs` … `icon2xl` | `w-3 h-3` … `w-8 h-8` | Icon sizes |
| `flexRowGap2` / `-3` | `flex items-center gap-2` / `-3` | Row layouts |

Sizes are the spacing scale, in quarter-rems — `min-w-45` is 180 px, `w-22.5`
is 90 px — and text the size scale, which has a `2xs` step (10 px on a 14 px
line) below `xs`; an arbitrary `[…]` value is for what the scale cannot say
(a `vh`, a grid template, a property list), never a length or a size.

### Buttons — [Button.tsx](../frontend/wiretap-ui/src/components/Button.tsx)

`<Button>` and `<IconButton>` render the `.btn` classes in
[components.css](../frontend/wiretap-ui/src/styles/components.css). Props:

| Prop | Values | Notes |
|---|---|---|
| `variant` | `surface` (default) · `solid` · `outline` · `ghost` · `tonal` · `link` | `IconButton` defaults to `ghost` |
| `tone` | `neutral` (default) · `primary` · `success` · `danger` · `warning` · `purple` · `cyan` | Colours the text on every variant, the fill on `solid`, the tint on `tonal` |
| `size` | `xs` 20 px · `sm` 26 px · `md` 32 px (default) · `lg` 40 px | Heights; icon buttons are square |
| `pressed` | `boolean` | A toggle. Renders `aria-pressed`; lit toggles take the tint, unlit ones are neutral whatever the tone |
| `label` | string (`IconButton` only) | Accessible name; also the tooltip unless `title` is given |

Where each goes:

| Situation | Use |
|---|---|
| Toolbar action, text or icon+text | `<Button>` |
| Toolbar icon | `<IconButton variant="surface">` |
| Card / row / dialog-header icon (edit, close, ↺) | `<IconButton>` (ghost), `size="sm"` in tight rows, `xs` inside table rows |
| Delete icon | `<IconButton tone="danger">` |
| Dialog footer | `PrimaryButton` / `SecondaryButton` / `DangerButton` / `SuccessButton` from `components/forms` — `lg` presets over `Button` |
| Playback / transport | `variant="solid"` with `tone="success"` · `warning` · `danger` |
| Toolbar toggle | `<IconButton variant="surface" pressed={on}>`, a `tone` when it is hue-coded |
| Option chip in a form | `<Button variant="outline" size="sm" pressed={selected}>` |
| Inline action chip beside text | `<Button variant="tonal" size="sm" tone="…">` |
| Text link ("Add filter", "Learn more") | `<Button variant="link" tone="primary">` |

`buttonClass({ variant, tone, size, icon })` returns the same class
string for the rare element that must not be a `<button>`.

### Inputs — [components/forms](../frontend/wiretap-ui/src/components/forms/)

`<Input>`, `<Select>` and `<Textarea>` render the `.input` classes in
[components.css](../frontend/wiretap-ui/src/styles/components.css);
`<Checkbox>` and `<Radio>` render `.check`. Props:

| Prop | Values | Notes |
|---|---|---|
| `size` | `xs` 20 px · `sm` 26 px · `md` 32 px (default) · `lg` 40 px | The button scale, so a control and the button beside it share a row. Dialog and settings forms are `lg`, toolbars `sm`, table cells `xs` |
| `tone` | `danger` · `warning` | Validation state: tinted background and border. `aria-invalid` renders as `danger` on its own |
| `mono` | `boolean` | Monospace text for ids, hex and paths |
| `size` (`Checkbox` / `Radio`) | `sm` 14 px · `md` 16 px (default) | The 14 px box is for table rows and dense lists |

Every control is `--bg-primary` on a 1 px `--border-default` at
`--radius-control`, full width unless told otherwise (`w-auto` for an
intrinsic-width toolbar select, `w-24` for a narrow number), and takes the
accent on focus and 50 % opacity when disabled. `<Select>` wraps the element
to draw the app's own chevron, so its `className` sizes the wrapper and
`ref` reaches the `<select>`. `inputClass({ size, tone, mono })` is the same
class string for a control rendered by a library (the date picker).

`<CheckboxField>` is a checkbox with its label; `<FormField>` a label over a
control; `<BaudRateSelect>` the preset-or-custom baud picker.
[typography.ts](../frontend/wiretap-ui/src/styles/typography.ts) holds the
form text tokens: `labelDefault`, `labelSimple`, `helpText`, `toolPanelLabel`.

### Badges — [components/Badge.tsx](../frontend/wiretap-ui/src/components/Badge.tsx)

`<Badge>` renders the `.badge` classes in
[components.css](../frontend/wiretap-ui/src/styles/components.css). A badge
is a label, not a control: one that answers a click is a
`<Button variant="tonal">` (or `variant="outline"` with `pressed` for a
filter toggle). Props:

| Prop | Values | Notes |
|---|---|---|
| `tone` | `neutral` (default) · `primary` · `success` · `danger` · `warning` · `purple` · `cyan` | The buttons' tint sets; neutral is `--bg-tertiary` |
| `variant` | `tonal` (default) · `outline` | Outline is transparent with the tone's border — a coloured edge with no fill |
| `size` | `sm` 16 px · `md` 20 px (default) · `lg` 24 px | Its own scale, not the control scale: `sm` for dense lists and log rows, `md` beside table text and in top bars, `lg` in cards, dialogs and Settings |
| `mono` | `boolean` | Monospace for ids, addresses and hex |

`<SummaryBadge label value>` is the `label: value` pair the device cards and
Data IO profiles show. A protocol's badge takes its tone from
`protocolTone()` in [utils/profileTraits.ts](../frontend/wiretap-ui/src/utils/profileTraits.ts)
(CAN green, CAN FD cyan, Modbus amber, Serial purple) and a Modbus register
type from `MODBUS_REGISTER_TONES` beside it, so the same thing wears the same
hue on every screen. `badgeClass({ tone, variant, size, mono })` is the class
string for an element that cannot be a `<span>`.

### Cards & alerts — [Card.tsx](../frontend/wiretap-ui/src/components/Card.tsx) · [Alert.tsx](../frontend/wiretap-ui/src/components/Alert.tsx)

`<Card>` renders the `.card` classes in
[components.css](../frontend/wiretap-ui/src/styles/components.css): a
bordered surface at `--radius-panel`, `--bg-surface` on `--border-default`.
Props:

| Prop | Values | Notes |
|---|---|---|
| `padding` | `none` · `sm` 8 px · `md` 12 px (default) · `lg` 16 px | `lg` for the list-row cards in Settings and Devices, `md` for boxes inside a dialog, `sm` for dense result panels, `none` when the children draw their own sections |
| `tone` | `info` · `success` · `warning` · `danger` · `purple` · `cyan` | Tints the fill and the edge only — the content keeps its own colours. For a tinted section, a result box, a colour-coded candidate |
| `interactive` | `boolean` | A card that answers a click: pointer cursor and the surface hover lift |
| `selected` | `boolean` | The chosen option among interactive cards; takes the accent tint like a lit toggle |

`cardClass({ tone, padding, interactive, selected })` is the class string
for a card that must be a `<button>` (an option card) or a `<label>` (a
radio option box).

`<Alert tone>` renders `.alert`: a tinted message with the tone's glyph —
box, text and glyph all come from the one `tone`, so the consumer sets none
of them. Props:

| Prop | Values | Notes |
|---|---|---|
| `tone` | `info` · `success` · `warning` · `danger` | Required. Info and success draw ⓘ and ✓, warning and danger the triangle |
| `size` | `sm` 8 px inset, 12 px text · `md` 12 px, 14 px (default) · `lg` 16 px | `sm` for the one-line validation error under a form and in-list errors |
| `banner` | `boolean` | The strip form: full width, square, only its bottom edge drawn — under a toolbar or at the top of a dialog body |
| `icon` | `ReactNode` | Replaces the glyph. Only when the picture carries a meaning the tone does not — a spinner for progress, the transmit-risk radio, the secret shield — never a second "something is wrong" glyph |
| `action` | `ReactNode` | Trailing control, right-aligned and centred on the message — a Dismiss link, a Stop button |

Inside an alert, a heading line is `font-medium` and a detail line
`text-xs`; do not recolour the text. A message that needs its own layout as
well — a summary header with a big icon, a row per finding with its own
glyph — is a toned `<Card>`, not an alert.

### Dialogs — [Dialog.tsx](../frontend/wiretap-ui/src/components/Dialog.tsx)

`<Dialog>` renders `.dialog-backdrop > .dialog`: one surface at
`--radius-dialog` in three slots — a pinned header, a body that scrolls, a
pinned footer — so a tall dialog never grows past the window. The width is
the `size`; the height is the content. Props:

| Prop | Values | Notes |
|---|---|---|
| `isOpen` | `boolean` | Closed renders nothing |
| `onClose` | `() => void` | Makes the dialog dismissible: the header ✕, Escape and a click on the backdrop all call it. Leave it off a dialog that must be answered (a confirm, a save-or-discard) |
| `size` | `sm` 384 · `md` 448 (default) · `lg` 512 · `xl` 672 · `2xl` 896 · `3xl` 1280 px | `sm` confirms and one-field forms, `md` forms, `xl` editors with two columns, `2xl` tables and diffs, `3xl` the signal editor |
| `title` / `subtitle` / `icon` | `ReactNode` | The standard header: an optional leading glyph, the title (18 px / 600), an optional caption under it, the ✕ when dismissible |
| `className` | on the frame | Only for a fixed height (`h-[500px]`) when a list must not jump as it filters |

The slots are named exports from the same module:

- `<DialogBody>` — 16 px inset, scrolls. `padding="none"` when the children
  draw their own rows (a picker list, a tab strip with its panes); a body
  that stacks fields takes `className="space-y-4"`.
- `<DialogFooter>` — right-aligned `lg` buttons, 8 px apart, above a
  hairline. `className="justify-between"` for a hint or a left-hand action
  beside them.
- `<DialogHeader>` + `<DialogTitle>` — for a header the props cannot express
  (a title with a "new" button beside it, a back arrow instead of ✕, a
  48 px icon well). The header draws the ✕ itself when the dialog is
  dismissible; the first child takes the slack.

Anything that is not a body or footer — a `TabStrip`, a `LoadStatus` banner —
can sit between the slots as a direct child; only the body gives way when the
window is short. Escape reaches only the dialog opened last, so a picker
hosted by another dialog closes alone. Focus moves into the dialog on open and
back to the opener on close.

### Tabs — [Tabs.tsx](../frontend/wiretap-ui/src/components/Tabs.tsx)

`<Tabs>` is the strip (a `tablist`; ← → Home End move along it and select
as they go) and `<Tab selected>` one choice in it, rendering `.tabs` and
`.tabs__tab`. One look: 12 px / 500 text at 32 px, `--text-secondary`
lifting to `--text-primary`, the current tab underlined 2 px in
`--accent-primary` over the strip's hairline. Props:

| Prop | Values | Notes |
|---|---|---|
| `variant` | `underline` (default) · `segmented` | Segmented is the pill form for a mode switch (Local / UTC, Both / ID / Data, Edit / Diff): a `--bg-tertiary` trough at `--radius-control`, the current tab lifted on `--bg-primary`, 26 px tall to sit beside `sm` controls |
| `inline` | `boolean` | No hairline of its own — the strip sits in a bar that draws one (`DataViewTabBar`) |

A tab trails `<TabCount tone>` (`neutral` · `success` · `warning` ·
`purple` — what the count is, not decoration) and `<TabDot tone>` (`purple`
default · `danger` · `warning` · `info`: something is happening on a tab that
is not current). A glyph before the label is a bare `<Icon />`; the strip
sizes it to 14 px. The declarative forms are
[TabStrip.tsx](../frontend/wiretap-ui/src/components/TabStrip.tsx) (a list of
`TabDef`s inside a dialog) and `DataViewTabBar` (through `AppTabView`); write
`<Tabs>` / `<Tab>` directly when the strip carries anything else.

### Menus — [Menu.tsx](../frontend/wiretap-ui/src/components/Menu.tsx)

`<Popover>` is the floating surface (`.popover`: `--bg-surface`, a hairline,
`--radius-panel`, the `xl` shadow), portalled to the body so no scroller
clips it, placed under its `anchorRef` — above when there is no room, clamped
to the window — or `at` a point, and dismissed by Escape and a mousedown
outside it. `<Menu>` is a popover with `role="menu"`, ↑ ↓ Home End between its
items, and focus returned to the opener. Props:

| Prop | Values | Notes |
|---|---|---|
| `open` / `onClose` | | The opener toggles `open`; the menu calls `onClose` for Escape, an outside click and after an item |
| `anchorRef` | `RefObject<HTMLElement>` | The trigger; put `aria-haspopup` and `aria-expanded` on it |
| `at` | `{ x, y }` | A context menu at the pointer instead of an anchor |
| `align` | `start` (default) · `end` | Which edge lines up with the anchor's — `end` for a kebab at the end of a row |
| `matchWidth` | `boolean` | As wide as the anchor — a list under its field |
| `size` | `md` (default) · `lg` | `lg` is the app launcher: 14 px text, 32 px rows, 18 px glyphs |

`usePopover(popup)` holds the open state between a trigger and its popover:
spread its `trigger` on the button (ref, toggle, `aria-haspopup`,
`aria-expanded`) and its `popover` on the `<Menu>`; `close` for a row that
must close by hand. Rows are `<MenuItem>` (12 px text, 28 px, `icon` in a 14 px well, `hint` for
a second line, `tone="danger" | "warning"` for a destructive or a leaving
action, `checked` for a toggle — lit in the info tint like a pressed button;
an item closes the menu after its click unless `keepOpen`),
`<MenuSeparator>` and `<MenuHeading>` (a 10 px uppercase caption). A picker's
option list is a `<Popover role="listbox">` of `<MenuItem role="option"
aria-selected>` rows. Escape reaches only the layer opened last — dialogs,
menus and popovers share one stack in
[dismiss.ts](../frontend/wiretap-ui/src/components/dismiss.ts) — so a menu
over a dialog closes alone. `ContextMenu` (items at a point) and
`OverflowMenu` (a kebab with items) are the declarative forms.

### Data tables — [Table.tsx](../frontend/wiretap-ui/src/components/Table.tsx)

`<Table>` renders `.table`: the table carries the design and a cell carries
only its alignment and tone, so `<th>` and `<td>` stay bare — no padding, no
colour, no font classes. 12 px text; the head is `--text-secondary` at 500,
start-aligned, over a hairline. Props:

| Prop | Values | Notes |
|---|---|---|
| `size` | `md` (default) · `sm` | `md` is read a row at a time — 24 px rows with a half-strength hairline between them (the Modbus results, the session log, Transmit, Query stats, Frame Order, Test Pattern). `sm` is the dense data table scanned down its columns — 20 px rows, no rules (the frame table, the byte dump, the CSV preview) |
| `mono` | `boolean` | The body in `--font-mono`; the head stays in the UI face. A mixed table (ids in mono, labels in prose) puts `font-mono` on the cells instead |
| `sticky` | `boolean` | The head stays put while the scroll container behind it scrolls. The table and its head take the surface they sit on, so the scroller must have one — `bgDataView` for a data view, a `Card` for a result table |
| `hover` | `boolean` | Rows tint `--hover-bg` under the pointer |

`aria-current` on a `<tr>` marks the current position (the playback frame)
in the cyan tint with a line above and below; `table__pin` on a cell keeps
it in view while the table scrolls sideways (the CSV preview's row numbers,
the mux table's selector column). Column widths are `w-*` on the `<th>` or a
`<colgroup>`; numeric columns take `text-right`; cell colours are the data
accents (`textDataGreen`, `textDataYellow`, …) or the text tokens. The scroll
container is the caller's — `flex-1 min-h-0 overflow-auto ${bgDataView}` for
a view that fills its panel, `<Card padding="none" className="overflow-hidden">`
for a result table in a page.

Two things worth knowing before changing the frame table's columns:

- **ASCII is not a column.** It shares the Data cell with the hex, as two
  non-breaking spans, because a column cannot move: payload length spans two
  orders of magnitude across protocols, and the pair has to sit side by side when
  there is room and stack when there is not. Every row's hex is padded to the
  page's widest run (`hexRunChars` in [byteUtils.ts](../frontend/wiretap-ui/src/utils/byteUtils.ts))
  so the ASCII behind it stays in a straight gutter.
- **Time is sized to the format in use**, via `TIME_COLUMN_CHARS` in
  [timeFormat.ts](../frontend/wiretap-ui/src/utils/timeFormat.ts). A column wide enough for an ISO
  timestamp is nearly twice what a delta needs, and the slack shows up as a gap
  before whatever column follows.

### App hues — [AppIcon.tsx](../frontend/wiretap-ui/src/components/AppIcon.tsx)

Every app has one hue, named in its registry entry (`hue: "purple"`): one of
the theme's data accents (`--text-<hue>`, the 600 in the light theme and the
400 in the dark), which `.app-hue--<hue>` in `components.css` reads into
`--app-accent`. Wherever the app is named, its glyph is
`<AppIcon app="discovery" className={iconLg} />`: the Dockview tab, the top
bar (through `AppTopBar`'s `app` prop), the logo menu, the launcher and the
session canvas all draw it that way, so an app never wears two colours.
`appHueClass(app)` puts the hue on a container instead — `--app-accent` and
`--app-tint` (10 %) for whatever inside reads them: a logo-menu row hovers in
its app's tint, and the launcher's tile is a tonal `Button` on it.
`app={null}` is a subscriber that is not a panel (an MCP client): a neutral
glyph, no hue. `isPanelId()` in the registry narrows a runtime id.

### The protocol badge says what it knows

`ProtocolBadge` labels a data view with the protocol on screen. It has **no
default**: with nothing captured and no source selected there is no protocol, and
it shows a dash. That is a rule learned twice — the badge and Discovery both used
to fall back to `"CAN"`, so a Modbus tool that owns no session sat under a CAN
label. Evidence, most direct first: a frame in hand, then what the capture says it
holds, then the session's declared protocol, then — in Discovery — the open tool
tab, for a tool that speaks one protocol and owns no session
(`protocolForToolTab`). A path that genuinely must name a protocol (a frame key,
an export filename) picks its own fallback explicitly rather than leaning on the
badge's.

## Composition recipes

### Toolbar action button (icon + label)

```tsx
import { iconMd } from "../../../styles";
import { Button } from "../../../components/Button";
import { Play } from "lucide-react";

<Button onClick={onStart}>
  <Play className={iconMd} />
  {t("controls.start")}
</Button>
```

### Dialog with footer

```tsx
import Dialog, { DialogBody, DialogFooter } from "../../components/Dialog";
import { PrimaryButton, SecondaryButton } from "../../components/forms";

<Dialog isOpen={open} onClose={onClose} title={t("dialog.title")}>
  <DialogBody className="space-y-4">{/* fields */}</DialogBody>
  <DialogFooter>
    <SecondaryButton onClick={onClose}>{t("common:actions.cancel")}</SecondaryButton>
    <PrimaryButton onClick={onConfirm}>{t("common:actions.confirm")}</PrimaryButton>
  </DialogFooter>
</Dialog>
```

### Form field with label and help

```tsx
import { labelDefault, helpText } from "../../../styles";
import { Input } from "../../../components/forms";

<div className="space-y-2">
  <label className={labelDefault}>{t("section.field.label")}</label>
  <p className={helpText}>{t("section.field.help")}</p>
  <Input size="lg" value={v} onChange={(e) => setV(e.target.value)} />
</div>
```

### Status badge inline

```tsx
import { Badge } from "../../components/Badge";

<Badge tone="success" size="lg">{t("status.connected")}</Badge>
```

### State glyph, state text, state dot

The tone says the state; the glyph, the text and the dot read the same
variable so they agree.

```tsx
import { iconSm, textSuccess, textDanger } from "../../styles";
import { CircleCheck, CircleX } from "lucide-react";

{ok ? <CircleCheck className={`${iconSm} ${textSuccess}`} /> : <CircleX className={`${iconSm} ${textDanger}`} />}
<p className={ok ? textSuccess : textDanger}>{message}</p>
<span className={`w-2 h-2 rounded-full ${ok ? "bg-success-text" : "bg-danger-text"}`} />
```

### A source in its kind's hue

```tsx
import { sourceKindColours } from "../../styles";

const look = sourceKindColours[isCapture ? "capture" : isRealtime ? "realtime" : "recorded"];
<Database className={`${iconSm} ${look.text}`} />
<div className={`rounded-lg border ${selected ? look.tint : `border-default ${look.hoverEdge}`}`}>…</div>
```

### Toast

```tsx
import FlashNotification from "../../components/FlashNotification";

{notice && <FlashNotification message={notice} type="success" onDismiss={() => setNotice(null)} />}
```

A toast is an `<Alert>` on a surface, pinned top-right; `type` is `info` ·
`success` · `warning` · `error`, `duration` 0 keeps it until dismissed.

### Empty state

```tsx
import { emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from "../../styles";

<div className={emptyStateContainer}>
  <div className={emptyStateText}>
    <p className={emptyStateHeading}>{t("empty.heading")}</p>
    <p className={emptyStateDescription}>{t("empty.description")}</p>
  </div>
</div>
```

### Data view container ("bubble")

```tsx
import { dataViewContainer, bgDataView } from "../../styles";

<div className={`${dataViewContainer} ${bgDataView}`}>
  {/* table or list */}
</div>
```

## App top bar

Every panel renders its top bar through
[AppTopBar.tsx](../frontend/wiretap-ui/src/components/AppTopBar.tsx). It enforces a single,
flexible row containing five logical slots, in order:

```
[icon] | [identity picker] [secondary pickers] [ID format] [custom children] | [actions]
       FlexSeparator (between icon and the rest)
                                              FlexSeparator (only if actions)
```

- **Icon** — `app` names the panel; its icon and hue come from the
  registry (see *App hues*). There is no title: the identity picker
  conveys the context.
- **Identity picker** — see *Identity pickers* below. Session-bound apps
  pass an `ioSession` prop (renders `IOSessionControls`); apps bound to
  a single device kind pass their picker as `children` (e.g. Rules with
  `<FrameLinkDevicePicker>`).
- **Secondary pickers** — `framePicker` and `catalog` props drive the
  shared frame-and-catalog buttons that several apps use.
- **ID format** — pass `frameIdFormat` (boolean) to render the shared
  per-panel frame-id "Flip" toggle (see *Frame ID display format* below).
- **Custom children** — anything the app needs between the picker and
  the right-side actions (e.g. Discovery's Toolbox button).
- **Actions** — right-aligned action buttons (Save, Export, Refresh,
  …). `<IconButton variant="surface">` for icon-only, `<Button>` for
  icon+text.

### Single line, always

The top bar must fit on one row at any reasonable window width. If you
have more than ~5 actions, consolidate into a popover or move secondary
controls into the panel body. The bar wraps when overflowed but a
wrapped top bar is a UX failure — if you see wrapping in normal use,
trim controls.

### Extract a `<App>TopBar.tsx` wrapper

When a panel's top bar takes more than ~10 props, extract a wrapper
component following the
[DiscoveryTopBar](../frontend/wiretap-ui/src/apps/discovery/views/DiscoveryTopBar.tsx) /
[DecoderTopBar](../frontend/wiretap-ui/src/apps/decoder/views/DecoderTopBar.tsx) /
[RulesTopBar](../frontend/wiretap-ui/src/apps/rules/views/RulesTopBar.tsx) pattern. The
wrapper:
- accepts a flat props object,
- composes `AppTopBar` once,
- keeps `Rules.tsx` (or equivalent) free of inline JSX.

### Frame ID display format

Never read `display_frame_id_format` from settings to render a frame id,
and never thread a `displayFrameIdFormat` prop down a tree. Frame-id
rendering is centralised in
[useFrameIdFormat.tsx](../frontend/wiretap-ui/src/hooks/useFrameIdFormat.tsx): the global
setting is the *default*, and each panel may override it locally
(Auto → Dec → Hex) via the top-bar toggle. The override is ephemeral per
panel instance.

To make a panel honour the format:

1. Wrap the app's default export so its tree (top bar + content) shares
   one override scope:

   ```tsx
   function FooInner() { /* … */ }
   export default withFrameIdFormat(FooInner);
   ```

2. Pass `frameIdFormat` to the panel's `AppTopBar` to render the toggle.
3. Render ids through the context, not `formatFrameId` directly:

   ```tsx
   const { format } = useFrameIdFormat();   // format(id, isExtended?)
   // …
   {format(frame.frame_id, frame.is_extended)}
   ```

   For non-JSX display (clipboard copy, panel titles) read `effective`
   and call the `formatFrameId` util with it. The shared `FrameDataTable`
   and `FramePicker` already consume the context, so apps using them get
   the override for free. `getSaveFrameIdFormat` / `save_frame_id_format`
   is a *separate* concern (catalog export) and is unaffected.

## Main view container

Tabbed panel content lives inside a **data-view bubble** — a rounded
border container with a tab bar header and a content area below. Two
flavours, depending on whether the panel deals with streaming data:

### Streaming / data apps — use `AppTabView`

Apps that show frames, signals, or other live/recorded data (Discovery,
Decoder) use [AppTabView.tsx](../frontend/wiretap-ui/src/components/AppTabView.tsx). It
bundles `DataViewController` (tab bar + protocol badge + streaming
status + optional pagination toolbar + optional timeline scrubber)
inside `dataViewContainer` with a `bgDataView` content area.

### Configuration / control apps — bubble + `Tabs`

Apps that present static configuration tabs (Rules, future settings-style
panels) don't need the streaming machinery. Wrap content in
`dataViewContainer` directly and draw the strip with `<Tabs>` / `<Tab>`:

```tsx
import { dataViewContainer, bgDataView, bgSurface } from "../../styles";
import { Tab, Tabs } from "../../components/Tabs";

<div className={`flex flex-col flex-1 min-h-0 ${dataViewContainer}`}>
  <Tabs className={`flex-shrink-0 px-1 ${bgSurface}`}>
    {tabs.map((tab) => (
      <Tab key={tab.id} selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}>
        {tab.label}
      </Tab>
    ))}
  </Tabs>
  <div className={`flex-1 overflow-auto p-4 rounded-b-lg ${bgDataView}`}>
    {/* tab content */}
  </div>
</div>
```

Don't reinvent tab styling with custom highlights — `<Tabs>` gives the
consistent underline-with-accent look used across the app. Wrap the bubble
in `p-2 gap-2` if the panel also needs a status footer below it.

### Activity log (Log tab)

Long-running stateful apps (Rules) accumulate operation history —
configuration changes, persist/clear cycles, transient errors. Surface
that history as a **Log** tab inside the bubble rather than scattering
ephemeral toasts or a fixed-height footer. The Log tab is the
authoritative history; the picker's status dot already handles the
"current state" question without needing a footer for it.

Implementation: keep a `statusLog: StatusBarEntry[]` array in the store
(cap ~200 entries). Mirror every status update into the log via a
Zustand `subscribe` so existing setters don't need to be touched. The
log is **in-memory only** — it resets on disconnect and is not
persisted, so no manual "clear" affordance is needed. Render
newest-first with a colour-coded dot per entry. Include the entity ID
in every message ("Bridge 0x0001 added"), not just the verb — log
entries should read clearly without needing to cross-reference the
configuration tabs. See
[apps/rules/stores/rulesStore.ts](../frontend/wiretap-ui/src/apps/rules/stores/rulesStore.ts)
for the canonical implementation and
[apps/rules/views/LogView.tsx](../frontend/wiretap-ui/src/apps/rules/views/LogView.tsx) for
the rendering.

## Identity pickers

Two pickers, one visual language:

| Picker | When | File |
|---|---|---|
| `SessionButton` (inside `IOSessionControls`) | Session-bound apps (Discovery, Decoder, Transmit) | [SessionControls.tsx](../frontend/wiretap-ui/src/components/SessionControls.tsx) |
| `FrameLinkDevicePicker` | Apps bound to a single FrameLink device (Rules) | [FrameLinkDevicePicker.tsx](../frontend/wiretap-ui/src/components/FrameLinkDevicePicker.tsx) |

Both render as a compact surface `<Button>`: `[type icon] [status dot] [label]`.
Click opens a `<Popover>` of `<MenuItem role="option">` rows (never a native
`<select>` — popovers can show status dots and host-port hints; native
selects can't on every platform).

### Status-dot vocabulary

The same dot semantics apply to both pickers and to the small status
indicator in the operational footer:

| State | Token | Meaning |
|---|---|---|
| `connected` | `bg-success-text` | Active, streaming/usable now |
| `connecting` / `probing` | `bg-info-text animate-pulse` | Transient — work in flight |
| `connectable` | `bg-info-text` | Reachable (mDNS scan or recent probe) but not in use |
| `paused` | `bg-warning-text` | (Sessions only — pause state) |
| `unknown` | `bg-text-muted` | Not yet probed and not seen by background discovery |
| `missing` / `error` | `bg-danger-text` | Last probe failed, or active connection in error |

The dot reads the tone's text variable so it matches the glyph and the
label beside it; there is no other green.

### Liveness for device pickers

Device pickers need a "is this device reachable right now?" signal.
The reusable hook
[useFrameLinkDeviceLiveness](../frontend/wiretap-ui/src/hooks/useFrameLinkDeviceLiveness.ts)
provides one: a hybrid of background mDNS scan (cheap, passive) plus
on-demand probe (called by the picker on popover-open for any device
the scan hasn't seen). Reuse this pattern when adding pickers for new
device kinds — keep scan/probe state in a Zustand store so multiple
panels share one signal.

## Error display

WireTAP has four standard surfaces for error and status messages.
Choose the lightest weight one that fits the situation.

| Surface | Token / Component | Use when |
|---|---|---|
| **Inline banner** (recoverable, dismissable) | `<Alert tone="danger">` from [Alert.tsx](../frontend/wiretap-ui/src/components/Alert.tsx) — `size="sm"` under a form, `banner` under a toolbar | An operation failed but the panel is still usable; the user can retry |
| **Modal `ErrorDialog`** (blocking) | `useSessionStore.getState().showAppError(title, message, details?)` from [appError.ts](../frontend/wiretap-ui/src/utils/appError.ts) | Unexpected failure with technical detail the user should see (stack, server response) |
| **Toast `FlashNotification`** | [FlashNotification.tsx](../frontend/wiretap-ui/src/components/FlashNotification.tsx) | Transient confirmations and soft warnings that don't need acknowledgement |
| **Operational status footer** (Rules-style) | App-specific footer using semantic status colours | Long-running stateful apps that benefit from a persistent "last operation" line; pair with a coloured status dot |

### Inline banner recipe

```tsx
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";

{error && (
  <Alert
    tone="danger"
    size="sm"
    className="mx-2 mt-1"
    action={
      <Button variant="link" tone="danger" size="sm" onClick={clearError}>
        {t("common:actions.dismiss", "Dismiss")}
      </Button>
    }
  >
    {error}
  </Alert>
)}
```

### When to call `showAppError`

Reserve the modal for failures the user genuinely needs to see and
acknowledge — typically those carrying technical details (stack
traces, server responses) that are too noisy for a banner. Don't use
it for routine "couldn't load X" cases the inline banner already
handles.

```tsx
import { useSessionStore } from "../stores/sessionStore";

try {
  await persistSave();
} catch (e) {
  useSessionStore.getState().showAppError(
    "Persist failed",
    "Could not save rules to device NVS.",
    String(e),
  );
  throw e;
}
```

### Don'ts

- Don't paint an error yourself — `text-danger` is for a line of error text
  in a form or a bar; a box around it is `<Alert tone="danger">`.
- Don't `console.error` user-facing failures and leave them invisible.
  Surface them in the matching banner / dialog / toast.
- Don't stack two surfaces for the same failure (e.g. banner *and*
  modal *and* toast). Pick one. The footer status line is the
  exception — it's a passive log, not an alert.

## Localisation

Strings are loaded via [react-i18next](https://react.i18next.com/). The
language preference is stored as `language` in `settingsStore.general` and
applied by [WireTAP.tsx](../frontend/wiretap-ui/src/WireTAP.tsx) calling `i18n.changeLanguage()`.

### File layout

```
src/locales/
├── en-AU/
│   ├── common.json       # buttons, generic states, errors, units
│   ├── settings.json     # everything in src/apps/settings/
│   └── menus.json        # LogoMenu, panel titles, top bar
└── index.ts              # locale registry, SUPPORTED_LANGUAGES
```

To add a new locale: drop `src/locales/<code>/` with the same namespace files,
import them in [../frontend/wiretap-ui/src/locales/index.ts](../frontend/wiretap-ui/src/locales/index.ts), and add the
code to `SUPPORTED_LANGUAGES`. The Language picker in
[GeneralView](../frontend/wiretap-ui/src/apps/settings/views/GeneralView.tsx) will show it
automatically.

### Key naming

- One namespace per feature area. Cross-namespace lookups use a `ns:` prefix.
- Dot-paths within a namespace: `general.power.preventIdleSleep.label`.
- For repeated UI text (Save, Cancel, OK, Loading…), put it in `common.json`
  under `actions`, `states`, `errors`, `units`.
- **Strings owned by a shared component belong in `common.json` too**, under a
  key named for the domain rather than the caller — `common:modbus.holding` for
  the register-type options `registerTypeOptions` supplies to every Modbus
  dropdown. A shared control whose labels live in each caller's namespace is how
  the same dropdown ends up reading "FC 3" in one panel and "FC03" in another;
  that drift had already shipped before the options were lifted into
  [ModbusFields.tsx](../frontend/wiretap-ui/src/components/modbus/ModbusFields.tsx).
- Form fields follow the pattern `section.field.label` and `section.field.help`.
- Select option labels go under `section.field.options.<value>`.

### Using `t(…)`

```tsx
import { useTranslation } from "react-i18next";

function MyView() {
  const { t } = useTranslation("settings"); // namespace
  return (
    <>
      <h2>{t("general.title")}</h2>
      <button>{t("common:actions.save")}</button>   {/* cross-namespace */}
      <p>{t("captures.empty", "No captures")}</p>   {/* fallback string */}
    </>
  );
}
```

**Always pass the namespace.** `useTranslation()` with no argument resolves
against `defaultNS` (`common`), so a view's own keys silently render as their
raw dot-path — `tunnelView.request` on screen instead of "Request". Nothing
warns: not TypeScript, not the build, not a test. It shows only when someone
opens that view. The Decoder's Modbus tab shipped that way.

### Interpolation and plurals

```json
{
  "framesTransmitted_one": "{{count}} frame transmitted",
  "framesTransmitted_other": "{{count}} frames transmitted"
}
```

```tsx
{t("replay.framesTransmitted", { count: txCount })}
```

i18next picks the plural form from `count`. Use the suffix syntax (`_one` /
`_other` / `_zero` / `_few` / `_many`) — it works even when only `_other` is
present.

### Locale-aware formatting

Use `Intl.NumberFormat` / `Intl.DateTimeFormat` (or the `.toLocaleString()`
shorthand) and pass `i18n.language` as the locale where it isn't picked up
automatically:

```tsx
import { useTranslation } from "react-i18next";
const { i18n } = useTranslation();
value.toLocaleString(i18n.language);
```

### When *not* to translate

- Diagnostic logs (`tlog.info`, `console.log`) — operator-facing, English only.
- Internal IDs, panel IDs, profile kinds (`gvret_tcp`, `slcan`).
- Protocol field names with established meaning (`CAN-FD`, `EFF`, `RTR`,
  Modbus function codes). These are technical identifiers, not prose.

## Don'ts (with replacements)

| ❌ Don't | ✅ Do |
|---|---|
| `text-red-500` / `text-slate-400` / `bg-green-900/30` | `text-danger` / `text-muted` / `bg-success` — the palette does not compile; a colour is a tone or an accent |
| `bg-[#0b0f14]` / `text-[color:var(--x)]` | A variable in `WireTAP.css` (then `bg-<name>`), or a `style` prop for one element's own colour |
| `text-white` on `bg-accent-primary` | `<Button variant="solid" tone="primary">` — the fill's text is the fill's own |
| `text-green-500` glyph in one view, `text-emerald-400` in another | One name for one meaning: `text-success` for a state, `text-green` for a hue, `sourceKindColours` for a source |
| `bg-blue-600/30 text-blue-400` ad-hoc chip | `<Badge tone="primary">` — `mono` in a data panel |
| `<input className="w-full px-4 py-2 rounded-lg border …">` | `<Input size="lg">` — the class carries the look, the border and the focus ring |
| `<select className={…}>` | `<Select>` — draws the app's chevron on both platforms |
| `<input type="checkbox" className="accent-blue-500">` | `<Checkbox>` — the theme's accent, drawn the same on WebKit and WebView2 |
| `style={{ color: 'var(--text-secondary)' }}` | `className={textSecondary}` — or `text-secondary` written out |
| `<Button>Save</Button>` | `<Button>{t("common:actions.save")}</Button>` |
| `<button className="px-3 py-1.5 rounded bg-blue-600 text-white …">` | `<Button variant="solid" tone="primary">` — the tone reads the theme's accent |
| `<button className={`p-1 rounded ${hoverBg}`}>` | `<IconButton size="sm">` |
| `<div className="fixed top-4 right-4 bg-green-500 text-white …">` | `<FlashNotification type="success">` — an `<Alert>` on a surface |
| `<div className="p-4 rounded-lg border …">` | `<Card padding="lg">` — `tone` for a tinted section |
| `<div className="p-3 bg-danger border …">{error}</div>` | `<Alert tone="danger">{error}</Alert>` — the tone draws the box, the text and the glyph |

## Adding a new app

App registration is centralised in two files, plus the usual translation and
panel-style work. The Logo menu, Watermark dashboard, native Tauri menu, and
Dockview panel registry all fan out from the same data — you do **not** edit
those individually.

### Source-of-truth files

- **[../frontend/wiretap-ui/src/apps/apps.json](../frontend/wiretap-ui/src/apps/apps.json)** — structural data
  (`id`, `label`, `group`, `accelerator`, `singleton`) shared by TypeScript
  and Rust. The `groupOrder` array controls divider placement in both menus.
- **[../frontend/wiretap-ui/src/apps/registry.ts](../frontend/wiretap-ui/src/apps/registry.ts)** — TypeScript-only
  visual data (icon, hue, lazy import) keyed by panel id, plus hidden-only
  panels (analysis tools opened programmatically, never from the launcher).

### 1. Add the structural entry

Append to `apps` in [../frontend/wiretap-ui/src/apps/apps.json](../frontend/wiretap-ui/src/apps/apps.json):

```json
{ "id": "my-app", "label": "My App", "group": "utilities", "accelerator": "T" }
```

- `id` — kebab-case Dockview panel id (also used as i18n key after kebab-to-camel).
- `group` — must be one of `groupOrder` (currently `sessions` / `database` /
  `framelink` / `utilities` / `settings`). Order within a group is the
  declared order in the array.
- `accelerator` — optional; what follows `cmdOrCtrl+`. Numeric `1..0` are
  conventional for the first ten apps. Omit if there's no good shortcut.
- `singleton: true` — only Settings uses this today; opens via
  `openSettingsPanel()` rather than as a stacked Dockview panel.

### 2. Add the visual config

Append to `visualConfig` in [../frontend/wiretap-ui/src/apps/registry.ts](../frontend/wiretap-ui/src/apps/registry.ts),
keyed by the same `id`:

```ts
"my-app": {
  icon: Beaker,                          // lucide-react
  hue: "purple",                         // an AppHue — one of the theme's data accents
  load: () => import("./my-app/MyApp"),
},
```

The registry asserts at module load that every `apps.json` id has a
`visualConfig` entry; a missing one throws immediately.

### 3. Localise

Add the panel title to
[../frontend/wiretap-ui/src/locales/en-AU/menus.json](../frontend/wiretap-ui/src/locales/en-AU/menus.json) under
`panels.<i18nKey>`. The i18n key is the kebab-case id converted to camelCase
(`my-app` → `myApp`, `frame-calculator` → `frameCalculator`).

If the app has its own substantial UI, create a new namespace
`src/locales/en-AU/<app>.json` rather than overloading `menus.json`.

### 4. Hidden Dockview panels

Panels that should be Dockview-registered but never appear in the launcher
(e.g. Payload Analysis, Frame Order Analysis — opened programmatically from
inside another app) are added directly to `visualConfig` and listed in
`hiddenApps` inside [../frontend/wiretap-ui/src/apps/registry.ts](../frontend/wiretap-ui/src/apps/registry.ts). They
do **not** go in `apps.json`.

### 5. Panel style

- The app's top bar is `<AppTopBar app="my-app">` ([AppTopBar.tsx](../frontend/wiretap-ui/src/components/AppTopBar.tsx)); a hand-rolled bar draws `<AppIcon app="my-app" className={iconLg} />`.
- The panel root wraps in `h-full overflow-hidden` (Dockview requirement).
- Use tokens from [../frontend/wiretap-ui/src/styles/](../frontend/wiretap-ui/src/styles/) — no inline colour values.

### What the harness does for you

A single `apps.json` + `registry.ts` entry feeds:

| Surface | Code path |
|---|---|
| Dockview component registry | [MainLayout.tsx](../frontend/wiretap-ui/src/components/MainLayout.tsx) iterates `apps` |
| Panel tab title (i18n) | `apps[i].i18nKey` resolved via `t(\`panels.${key}\`)` |
| Watermark dashboard | [MainLayout.tsx](../frontend/wiretap-ui/src/components/MainLayout.tsx) iterates `menuApps` grouped by `menuGroupOrder` |
| Logo menu (with dividers) | [LogoMenu.tsx](../frontend/wiretap-ui/src/components/LogoMenu.tsx) iterates `menuApps` grouped by `menuGroupOrder` |
| Tab icon in the app's hue | [AppTab.tsx](../frontend/wiretap-ui/src/components/AppTab.tsx) draws `<AppIcon>` |
| Native Tauri **Apps** menu | [lib.rs](../crates/wiretap-app/src/lib.rs) `build_apps_menu` reads `apps.json` via `include_str!`, inserts separators between groups |
| `cmdOrCtrl+<accel>` shortcut | Built from the JSON `accelerator` field |

If a surface is missing your app, the cause is one of: missing `visualConfig`
entry, wrong `group` (not in `groupOrder`), or a stale Cargo cache (the JSON
is `include_str!`-embedded — rebuild Rust after editing `apps.json`).

### Why grouping is centralised

Logo menu, dashboard watermark, and native menu are three independent
rendering surfaces. When their order or grouping drifts, users learn one and
get confused by the others. Centralising structural data in `apps.json`
guarantees they can't drift; the Rust menu reads the same file the TypeScript
registry does, so a JSON edit re-flows all three surfaces consistently.

Session-aware apps belong in the `sessions` group — they share state through
[useIOSessionManager](../frontend/wiretap-ui/src/hooks/useIOSessionManager.ts) and benefit from
adjacency so related tooling is visible at a glance.

## Where things live

| Directory | What's there |
|---|---|
| [../frontend/wiretap-ui/src/styles/colourTokens.ts](../frontend/wiretap-ui/src/styles/colourTokens.ts) | Surfaces, text, borders, status, data accents, hover, interactive |
| [../frontend/wiretap-ui/src/styles/typography.ts](../frontend/wiretap-ui/src/styles/typography.ts) | Headings, body, mono, form labels and help text, empty-state, truncation |
| [../frontend/wiretap-ui/src/styles/spacing.ts](../frontend/wiretap-ui/src/styles/spacing.ts) | Padding, gaps, vertical spacing, margins, radius, icon sizes, flex helpers |
| [../frontend/wiretap-ui/src/components/](../frontend/wiretap-ui/src/components/) | `Button`, `Badge`, `Card`, `Alert`, `Dialog`, `Tabs`, `Menu`, `Table`, `AppIcon` and `forms/` — the primitives, over `styles/components.css` |
| [../frontend/wiretap-ui/src/styles/index.ts](../frontend/wiretap-ui/src/styles/index.ts) | Single barrel — import from here |
| [../frontend/wiretap-ui/src/locales/en-AU/common.json](../frontend/wiretap-ui/src/locales/en-AU/common.json) | Buttons, generic states, errors, units |
| [../frontend/wiretap-ui/src/locales/en-AU/settings.json](../frontend/wiretap-ui/src/locales/en-AU/settings.json) | Settings panel strings |
| [../frontend/wiretap-ui/src/locales/en-AU/menus.json](../frontend/wiretap-ui/src/locales/en-AU/menus.json) | Logo menu, panel titles |
| [../frontend/wiretap-ui/src/locales/index.ts](../frontend/wiretap-ui/src/locales/index.ts) | Locale registry, supported languages |
| [../frontend/wiretap-ui/src/i18n.ts](../frontend/wiretap-ui/src/i18n.ts) | i18next bootstrap |
| [../frontend/wiretap-ui/src/components/MainLayout.tsx](../frontend/wiretap-ui/src/components/MainLayout.tsx) | Panel registry, dashboard watermark |
| [../frontend/wiretap-ui/src/components/LogoMenu.tsx](../frontend/wiretap-ui/src/components/LogoMenu.tsx) | App launcher menu |
| [../crates/wiretap-app/src/lib.rs](../crates/wiretap-app/src/lib.rs) | Native Tauri menu, panel-open events |

## What is not a primitive yet

The option rows inside pickers and dialogs (a `w-full text-left` `<button>`
with its own hover and selected look), the Settings sidebar, the fake
checkbox and radio drawn inside a row, the toggle switch in the FrameLink
signal control, and the Catalog Editor's field tiles are still hand-rolled;
each is in the register (*Bugs and Feature gaps* in the vault) under
*Frontend styling*, and a new one should copy an existing row rather than
invent a third look. Additional locales (`en-US`, `de`, `ja`, …) are a
folder plus a line in `src/locales/index.ts`.

# WireTAP Frontend Style Guide

This guide describes how to build UI in WireTAP — what styling tokens to use,
how to localise strings, how to register a new app, and which inline patterns
should be migrated to centralised tokens. It is the canonical reference for
the frontend; if a question is not answered here, prefer reading the source in
[../src/styles/](../src/styles/) over inventing a new pattern.

## Overview

All visual styling is centralised in [../src/styles/](../src/styles/). The
public surface is the barrel file [../src/styles/index.ts](../src/styles/index.ts) —
import tokens from there:

```tsx
import { buttonBase, textPrimary, paddingDialog, h2 } from "../../../styles";
```

Localisation lives in [../src/locales/](../src/locales/). The active language
is driven by the `language` field in `settings.json` (see
[../src/apps/settings/stores/settingsStore.ts](../src/apps/settings/stores/settingsStore.ts)).
The bootstrap is [../src/i18n.ts](../src/i18n.ts), imported once for side
effects from [../src/main.tsx](../src/main.tsx).

## Core principles

These are non-negotiable in this codebase:

1. **No `dark:` Tailwind variants.** They don't get generated in Windows WebView
   when written inside string constants. Use CSS variable tokens instead.
2. **Use CSS variable tokens, not raw Tailwind colour classes.** `text-gray-400`
   becomes `textDataSecondary` (or another data-text token). The tokens read
   from `:root` CSS variables set by `useTheme`, so themes work cross-platform.
3. **Australian English** in all UI strings, comments, identifiers. "Colour",
   "centralised", "organisation". Project-wide rule from
   [../CLAUDE.md](../CLAUDE.md).
4. **Every user-facing string goes through `t(…)`.** No JSX text literals.
5. **Raw `<button>` and `<input>` + style constants** is the convention, not
   wrapper components. Centralising the *classes* gives reuse without locking
   in props.
6. **Hover states use `hover:brightness-{n}`**, not `hover:bg-{color}-{n}`.
   Brightness filters work uniformly against a CSS-variable background; bg
   classes don't.

## Theming model

`useTheme` ([../src/hooks/useTheme.ts](../src/hooks/useTheme.ts)) sets CSS
variables on `:root` based on the user's theme settings:

- `--bg-primary`, `--bg-surface`, `--text-primary`, `--text-secondary`,
  `--border-default`, `--data-bg`, `--accent-primary`, status colours, etc.

Tokens in [colourTokens.ts](../src/styles/colourTokens.ts) are Tailwind
arbitrary-value classes that read those variables:

```ts
export const textPrimary = "text-[color:var(--text-primary)]";
export const bgSurface = "bg-[var(--bg-surface)]";
```

Result: a single CSS variable change at runtime re-themes everything that uses
the token. Hardcoded `text-zinc-100` will not update.

## Token reference

### Colours — [colourTokens.ts](../src/styles/colourTokens.ts)

| Token | Class | Use |
|---|---|---|
| `bgPrimary` | `bg-[var(--bg-primary)]` | App background |
| `bgSurface` | `bg-[var(--bg-surface)]` | Dialogs, panels, cards |
| `bgDataView` | `bg-[var(--data-bg)]` | Data table background |
| `textPrimary` | `text-[color:var(--text-primary)]` | Headings, main content |
| `textSecondary` | `text-[color:var(--text-secondary)]` | Descriptions, labels |
| `textTertiary` | `text-[color:var(--text-secondary)] opacity-80` | Muted info |
| `textMuted` | `text-[color:var(--text-muted)]` | Disabled, placeholder |
| `textDataPrimary` / `-Secondary` / `-Tertiary` / `-Muted` / `-Placeholder` / `-Disabled` | (data CSS vars) | Text inside data views; `-Disabled` pairs with a themed accent for inactive state |
| `borderDefault` | `border-[color:var(--border-default)]` | Default border |
| `borderSubtle` | `border-[color:var(--border-default)] opacity-50` | Dividers |
| `borderDivider` | `border-b border-[color:var(--border-default)]` | Section separators |
| `bgSuccess` / `bgDanger` / `bgWarning` / `bgInfo` | (status CSS vars) | Status backgrounds |
| `textSuccess` / `textDanger` / `textWarning` / `textInfo` | (status CSS vars) | Status text |
| `borderSuccess` / `borderDanger` / `borderWarning` / `borderInfo` | (status CSS vars) | Status borders |
| `bgPurple` / `textPurple` / `borderPurple` | (purple CSS vars) | Purple highlights |
| `bgCyan` / `textCyan` / `borderCyan` | (cyan CSS vars) | CAN-FD / enhanced protocol |
| `textDataGreen` / `-Yellow` / `-Orange` / `-Purple` / `-Amber` / `-Cyan` | (text-{colour} CSS vars) | Cell / syntax highlighting |
| `bgInteractive` | `bg-[var(--accent-primary)] hover:brightness-110` | Primary action background |
| `textInteractive` | `text-[color:var(--accent-primary)] hover:brightness-110` | Primary action text |
| `focusRing` | `focus:ring-2 focus:ring-[color:var(--accent-primary)] focus:outline-none` | Focus outline; tracks the user's accent colour |
| `focusRingThin` | `focus:ring-1 focus:ring-[color:var(--accent-primary)] focus:outline-none` | Compact variant for tight controls (small inputs, toolbars) |
| `focusBorder` | `focus:outline-none focus:border-[color:var(--accent-primary)]` | For inputs that highlight via border colour rather than a ring |
| `hoverBg` / `hoverLight` / `hoverSubtle` / `hoverDataItem` / `hoverDataRow` | brightness or `var(--hover-bg)` | Hover states |
| `dataViewContainer` | `rounded-lg border border-… overflow-hidden` | Standard data "bubble" |

### Typography — [typography.ts](../src/styles/typography.ts)

| Token | Use |
|---|---|
| `h1` / `h2` / `h3` / `h4` | Heading levels |
| `bodyDefault` / `bodyLarge` / `bodySmall` | Body text |
| `mono` / `monoBody` | Code / monospace |
| `caption` / `captionMuted` | Captions |
| `emphasis` / `textMedium` | Inline emphasis |
| `labelSmall` / `labelSmallMuted` / `sectionHeader` / `sectionHeaderText` | Labels and section headers |
| `truncate` / `lineClamp2` / `lineClamp3` | Truncation |
| `emptyStateContainer` / `emptyStateText` / `emptyStateHeading` / `emptyStateDescription` / `emptyStateHint` | "No data" / "Not connected" displays |

### Spacing — [spacing.ts](../src/styles/spacing.ts)

| Token | Class | Use |
|---|---|---|
| `paddingDialog` | `p-6` | Dialog/modal content |
| `paddingCard` / `paddingCardSm` | `p-4` / `p-3` | Card content |
| `paddingSection` | `p-8` | Large sections |
| `paddingButton` / `paddingButtonSm` | `px-4 py-2` / `px-3 py-1.5` | Button padding |
| `paddingIconButton` | `p-2` | Icon buttons |
| `paddingBadge` | `px-2 py-1` | Badges, chips |
| `paddingAppBarX` / `marginAppContent` | `px-4` / `m-2` | App-bar / panel chrome |
| `gapTight` / `gapSmall` / `gapDefault` / `gapLarge` / `gapXLarge` | `gap-1`/`-2`/`-4`/`-6`/`-8` | Flex/grid gaps |
| `spaceYTight` / `-Small` / `-Default` / `-Large` | `space-y-1`/`-2`/`-4`/`-6` | Vertical spacing |
| `marginSection` / `marginHeading` / `marginParagraph` | `mb-6`/`-4`/`-2` | Trailing margins |
| `roundedSm` / `roundedDefault` / `roundedLarge` / `roundedFull` | `rounded` / `-lg` / `-xl` / `-full` | Border radius |
| `iconXs` … `icon2xl` | `w-3 h-3` … `w-8 h-8` | Icon sizes |
| `flexRow` / `flexRowGap1`/`-2`/`-3` | flex helpers | Row layouts |

### Buttons — [buttonStyles.ts](../src/styles/buttonStyles.ts)

| Token | Use |
|---|---|
| `buttonBase` | Default toolbar button (text + icon) |
| `iconButtonBase` | Icon-only toolbar button |
| `dangerButtonBase` / `warningButtonBase` / `successIconButton` | Stop / detach / resume in toolbars |
| `playButtonBase` / `pauseButtonBase` / `stopButtonBase` (+ `Compact` variants) | Playback controls |
| `primaryButtonBase` | Primary dialog action (Watch, Import, OK) |
| `successButtonBase` | Affirmative action (Ingest, Confirm) |
| `secondaryButton` / `dialogOptionButton` / `folderPickerButton` | Secondary / cancel / picker |
| `toggleButtonClass(active, colour)` | Toggle with purple/yellow/blue active state |
| `toggleCardClass(active)` / `toggleChipClass(active)` | Larger toggles |
| `selectionButtonClass(active)` / `groupButtonClass(active)` | Option selectors |
| `dataViewTabClass(active, hasIndicator)` | Data view tabs |
| `paginationButtonDark` / `tableIconButtonDark` | Data view chrome |
| `playbackIconButton` / `playbackStepButton(canStep)` | Themed playback toolbar buttons (skip/rewind, step) |
| `iconActionButton(colour)` | Coloured icon-only "create" button (blue/purple) |
| `actionChip(colour)` | Inline pill action button used next to text (blue/red/green/amber); themed via status CSS vars |
| `byteHighlight(state)` | Tri-state byte highlight (checksum / calcData / default) for frame previews |
| `iconButtonHover` / `-Compact` / `-Small` / `-Danger` / `iconButtonDanger` / `iconButtonDangerCompact` | Card / dialog action icons |
| `launcherButton` / `launcherButtonLabel` / `launcherGrid` | Watermark app launcher |
| `disabledState` | `disabled:opacity-50 disabled:cursor-not-allowed` |
| `badgeColorClass(colour)` / `tabCountColorClass(colour)` | Helpers (see backlog — colours hardcoded) |

### Inputs — [inputStyles.ts](../src/styles/inputStyles.ts)

| Token | Use |
|---|---|
| `inputDefault` | Settings, IO profile dialog forms |
| `inputSimple` | Compact / save dialogs |
| `selectDefault` / `selectSimple` | Match input variants |
| `toolbarSelect` | Dark theme for data view toolbars |
| `labelDefault` / `labelSimple` | Label variants |
| `helpText` | Description text below inputs |
| `formElementHeight` / `toolbarElementHeight` | `h-[42px]` / `h-[26px]` |
| `checkboxDefault` / `radioDefault` | Themed checkbox / radio styling |

### Badges — [badgeStyles.ts](../src/styles/badgeStyles.ts)

| Token | Use |
|---|---|
| `badgeSuccess` / `badgeDanger` / `badgeWarning` / `badgeInfo` / `badgeNeutral` / `badgePurple` / `badgeCyan` | Standard badges |
| `badgeSmall…` (Neutral / Success / Warning / Purple / Info / Danger) | Compact badges |
| `badgeDarkPanelInfo` / `-Success` / `-Danger` / `-Purple` / `-Cyan` | Mono data-panel badges |
| `badgeMetadata` | Filename / type pills |

### Cards & alerts — [cardStyles.ts](../src/styles/cardStyles.ts)

| Token | Use |
|---|---|
| `cardDefault` / `cardElevated` / `cardInteractive` | Containers |
| `alertInfo` / `alertWarning` / `alertDanger` / `alertSuccess` | Alert boxes |
| `detailBox` | Code / detail panel |
| `panelFooter` | Dialog/panel action footer |
| `expandableRowContainer` | Collapsible row header |
| `selectableOptionBox` | Radio/checkbox option box |
| `errorBoxCompact` | Inline form error (red, small) |
| `cardPadding.{none,sm,md,lg}` | Card padding helper |

## Composition recipes

### Toolbar action button (icon + label)

```tsx
import { buttonBase, iconMd } from "../../../styles";
import { Play } from "lucide-react";

<button className={buttonBase} onClick={onStart}>
  <Play className={iconMd} />
  {t("controls.start")}
</button>
```

### Dialog with footer

```tsx
import Dialog from "../../components/Dialog";
import { primaryButtonBase, secondaryButton } from "../../styles";

<Dialog isOpen={open} onClose={onClose} title={t("dialog.title")}>
  <div className="space-y-4">{/* body */}</div>
  <div className="flex justify-end gap-2 mt-6">
    <button className={secondaryButton} onClick={onClose}>
      {t("common:actions.cancel")}
    </button>
    <button className={primaryButtonBase} onClick={onConfirm}>
      {t("common:actions.confirm")}
    </button>
  </div>
</Dialog>
```

### Form field with label and help

```tsx
import { labelDefault, helpText, inputDefault } from "../../../styles";

<div className="space-y-2">
  <label className={labelDefault}>{t("section.field.label")}</label>
  <p className={helpText}>{t("section.field.help")}</p>
  <input className={inputDefault} value={v} onChange={(e) => setV(e.target.value)} />
</div>
```

### Status badge inline

```tsx
import { badgeSuccess } from "../../styles";

<span className={badgeSuccess}>{t("status.connected")}</span>
```

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
[AppTopBar.tsx](../src/components/AppTopBar.tsx). It enforces a single,
flexible row containing five logical slots, in order:

```
[icon] [title?] | [identity picker] [secondary pickers] [custom children] | [actions]
       FlexSeparator (between icon/title and the rest)
                                                       FlexSeparator (only if actions)
```

- **Icon + title** — `icon` is a `lucide-react` component, coloured via
  `iconColour` (use a CSS-variable text token, e.g.
  `text-[color:var(--text-purple)]`). `title` is optional — omit it if
  the identity picker conveys context on its own.
- **Identity picker** — see *Identity pickers* below. Session-bound apps
  pass an `ioSession` prop (renders `IOSessionControls`); apps bound to
  a single device kind pass their picker as `children` (e.g. Rules with
  `<FrameLinkDevicePicker>`).
- **Secondary pickers** — `framePicker` and `catalog` props drive the
  shared frame-and-catalog buttons that several apps use.
- **Custom children** — anything the app needs between the picker and
  the right-side actions (e.g. Discovery's Toolbox button).
- **Actions** — right-aligned action buttons (Save, Export, Refresh,
  …). Use `iconButtonBase` for icon-only and `buttonBase` for icon+text.

### Single line, always

The top bar must fit on one row at any reasonable window width. If you
have more than ~5 actions, consolidate into a popover or move secondary
controls into the panel body. The bar wraps when overflowed but a
wrapped top bar is a UX failure — if you see wrapping in normal use,
trim controls.

### Extract a `<App>TopBar.tsx` wrapper

When a panel's top bar takes more than ~10 props, extract a wrapper
component following the
[DiscoveryTopBar](../src/apps/discovery/views/DiscoveryTopBar.tsx) /
[DecoderTopBar](../src/apps/decoder/views/DecoderTopBar.tsx) /
[RulesTopBar](../src/apps/rules/views/RulesTopBar.tsx) pattern. The
wrapper:
- accepts a flat props object,
- composes `AppTopBar` once,
- keeps `Rules.tsx` (or equivalent) free of inline JSX.

## Main view container

Tabbed panel content lives inside a **data-view bubble** — a rounded
border container with a tab bar header and a content area below. Two
flavours, depending on whether the panel deals with streaming data:

### Streaming / data apps — use `AppTabView`

Apps that show frames, signals, or other live/recorded data (Discovery,
Decoder) use [AppTabView.tsx](../src/components/AppTabView.tsx). It
bundles `DataViewController` (tab bar + protocol badge + streaming
status + optional pagination toolbar + optional timeline scrubber)
inside `dataViewContainer` with a `bgDataView` content area.

### Configuration / control apps — bubble + `dataViewTabClass`

Apps that present static configuration tabs (Rules, future settings-style
panels) don't need the streaming machinery. Wrap content in
`dataViewContainer` directly and use `dataViewTabClass(isActive)` for
the tab buttons:

```tsx
import {
  dataViewContainer,
  bgDataView,
  bgDataToolbar,
  borderDataView,
} from "../../styles";
import { dataViewTabClass } from "../../styles/buttonStyles";

<div className={`flex flex-col flex-1 min-h-0 ${dataViewContainer}`}>
  <div className={`flex-shrink-0 flex items-center px-1 border-b ${borderDataView} ${bgDataToolbar}`}>
    {tabs.map((tab) => (
      <button
        key={tab.id}
        type="button"
        onClick={() => setActiveTab(tab.id)}
        className={dataViewTabClass(activeTab === tab.id)}
      >
        {tab.label}
      </button>
    ))}
  </div>
  <div className={`flex-1 overflow-auto p-4 rounded-b-lg ${bgDataView}`}>
    {/* tab content */}
  </div>
</div>
```

Don't reinvent tab styling with custom `bg-indigo-500/20` highlights —
`dataViewTabClass` gives the consistent bottom-border-with-accent look
used across the app. Wrap the bubble in `p-2 gap-2` if the panel also
needs a status footer below it.

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
[apps/rules/stores/rulesStore.ts](../src/apps/rules/stores/rulesStore.ts)
for the canonical implementation and
[apps/rules/views/LogView.tsx](../src/apps/rules/views/LogView.tsx) for
the rendering.

## Identity pickers

Two pickers, one visual language:

| Picker | When | File |
|---|---|---|
| `SessionButton` (inside `IOSessionControls`) | Session-bound apps (Discovery, Decoder, Transmit) | [SessionControls.tsx](../src/components/SessionControls.tsx) |
| `FrameLinkDevicePicker` | Apps bound to a single FrameLink device (Rules) | [FrameLinkDevicePicker.tsx](../src/components/FrameLinkDevicePicker.tsx) |

Both render as a compact `buttonBase`-styled control: `[type icon] [status dot] [label]`.
Click opens a popover (never a native `<select>` — popovers can show
status dots and host-port hints; native selects can't on every platform).

### Status-dot vocabulary

The same dot semantics apply to both pickers and to the small status
indicator in the operational footer:

| State | Token | Meaning |
|---|---|---|
| `connected` | `bg-[var(--status-success-text)]` | Active, streaming/usable now |
| `connecting` / `probing` | `bg-[var(--status-info-text)] animate-pulse` | Transient — work in flight |
| `connectable` | `bg-[var(--status-info-text)]` | Reachable (mDNS scan or recent probe) but not in use |
| `paused` | `bg-[var(--status-warning-text)]` | (Sessions only — pause state) |
| `unknown` | `bg-[color:var(--text-muted)]` | Not yet probed and not seen by background discovery |
| `missing` / `error` | `bg-[var(--status-danger-text)]` | Last probe failed, or active connection in error |

Never hardcode `bg-green-500` etc. — colours must track the active
theme via the status CSS variables.

### Liveness for device pickers

Device pickers need a "is this device reachable right now?" signal.
The reusable hook
[useFrameLinkDeviceLiveness](../src/hooks/useFrameLinkDeviceLiveness.ts)
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
| **Inline banner** (recoverable, dismissable) | `bgDanger` + `borderDanger` + `textDanger`, or `errorBoxCompact` from [cardStyles.ts](../src/styles/cardStyles.ts) | An operation failed but the panel is still usable; the user can retry |
| **Modal `ErrorDialog`** (blocking) | `useSessionStore.getState().showAppError(title, message, details?)` from [appError.ts](../src/utils/appError.ts) | Unexpected failure with technical detail the user should see (stack, server response) |
| **Toast `FlashNotification`** | [FlashNotification.tsx](../src/components/FlashNotification.tsx) | Transient confirmations and soft warnings that don't need acknowledgement |
| **Operational status footer** (Rules-style) | App-specific footer using semantic status colours | Long-running stateful apps that benefit from a persistent "last operation" line; pair with a coloured status dot |

### Inline banner recipe

```tsx
import { bgDanger, borderDanger, textDanger } from "../../styles";

{error && (
  <div
    className={`mx-2 mt-1 px-3 py-2 text-xs rounded-lg flex justify-between items-center border ${bgDanger} ${borderDanger} ${textDanger}`}
  >
    <span>{error}</span>
    <button onClick={clearError} className="ml-2 underline hover:brightness-125">
      {t("common:actions.dismiss", "Dismiss")}
    </button>
  </div>
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

- Don't use raw Tailwind `bg-red-500/10`, `text-red-400` etc. — these
  bypass theming and look broken on Windows WebView.
- Don't `console.error` user-facing failures and leave them invisible.
  Surface them in the matching banner / dialog / toast.
- Don't stack two surfaces for the same failure (e.g. banner *and*
  modal *and* toast). Pick one. The footer status line is the
  exception — it's a passive log, not an alert.

## Localisation

Strings are loaded via [react-i18next](https://react.i18next.com/). The
language preference is stored as `language` in `settingsStore.general` and
applied by [WireTAP.tsx](../src/WireTAP.tsx) calling `i18n.changeLanguage()`.

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
import them in [../src/locales/index.ts](../src/locales/index.ts), and add the
code to `SUPPORTED_LANGUAGES`. The Language picker in
[GeneralView](../src/apps/settings/views/GeneralView.tsx) will show it
automatically.

### Key naming

- One namespace per feature area. Cross-namespace lookups use a `ns:` prefix.
- Dot-paths within a namespace: `general.power.preventIdleSleep.label`.
- For repeated UI text (Save, Cancel, OK, Loading…), put it in `common.json`
  under `actions`, `states`, `errors`, `units`.
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
| `dark:text-white` | `textPrimary` |
| `text-gray-400` in data tables | `textDataSecondary` / `textDataTertiary` / `textDataMuted` |
| `bg-blue-600/30 text-blue-400` ad-hoc chip | `badgeInfo` / `badgeColorClass(...)` / `badgeDarkPanelInfo` |
| `focus:ring-blue-500 focus:outline-none` | `focusRing` |
| `style={{ color: 'var(--text-secondary)' }}` | `className={textSecondary}` |
| `<button>Save</button>` | `<button>{t("common:actions.save")}</button>` |
| `bg-purple-600 hover:bg-purple-700 text-white` | `toggleButtonClass(true, "purple")` or extend `buttonStyles.ts` with a semantic variant |
| `hover:bg-zinc-700` | `hover:brightness-95` (or `hoverBg` for tokens) |

## Adding a new app

App registration is centralised in two files, plus the usual translation and
panel-style work. The Logo menu, Watermark dashboard, native Tauri menu, and
Dockview panel registry all fan out from the same data — you do **not** edit
those individually.

### Source-of-truth files

- **[../src/apps/apps.json](../src/apps/apps.json)** — structural data
  (`id`, `label`, `group`, `accelerator`, `singleton`) shared by TypeScript
  and Rust. The `groupOrder` array controls divider placement in both menus.
- **[../src/apps/registry.ts](../src/apps/registry.ts)** — TypeScript-only
  visual data (icon, colour classes, lazy import) keyed by panel id, plus
  hidden-only panels (analysis tools opened programmatically, never from the
  launcher).

### 1. Add the structural entry

Append to `apps` in [../src/apps/apps.json](../src/apps/apps.json):

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

Append to `visualConfig` in [../src/apps/registry.ts](../src/apps/registry.ts),
keyed by the same `id`:

```ts
"my-app": {
  icon: Beaker,                                            // lucide-react
  colour: "text-purple-400",                               // text colour
  bgColour: "hover:bg-purple-500/10",                      // LogoMenu hover
  watermarkBg: "bg-purple-500/10 hover:bg-purple-500/20",  // Watermark tile
  load: () => import("./my-app/MyApp"),
},
```

The registry asserts at module load that every `apps.json` id has a
`visualConfig` entry; a missing one throws immediately.

### 3. Localise

Add the panel title to
[../src/locales/en-AU/menus.json](../src/locales/en-AU/menus.json) under
`panels.<i18nKey>`. The i18n key is the kebab-case id converted to camelCase
(`my-app` → `myApp`, `frame-calculator` → `frameCalculator`).

If the app has its own substantial UI, create a new namespace
`src/locales/en-AU/<app>.json` rather than overloading `menus.json`.

### 4. Hidden Dockview panels

Panels that should be Dockview-registered but never appear in the launcher
(e.g. Payload Analysis, Frame Order Analysis — opened programmatically from
inside another app) are added directly to `visualConfig` and listed in
`hiddenApps` inside [../src/apps/registry.ts](../src/apps/registry.ts). They
do **not** go in `apps.json`.

### 5. Panel style

- The app's top bar uses [AppTopBar.tsx](../src/components/AppTopBar.tsx).
- The panel root wraps in `h-full overflow-hidden` (Dockview requirement).
- Use tokens from [../src/styles/](../src/styles/) — no inline colour values.

### What the harness does for you

A single `apps.json` + `registry.ts` entry feeds:

| Surface | Code path |
|---|---|
| Dockview component registry | [MainLayout.tsx](../src/components/MainLayout.tsx) iterates `apps` |
| Panel tab title (i18n) | `apps[i].i18nKey` resolved via `t(\`panels.${key}\`)` |
| Watermark dashboard | [MainLayout.tsx](../src/components/MainLayout.tsx) iterates `menuApps` grouped by `menuGroupOrder` |
| Logo menu (with dividers) | [LogoMenu.tsx](../src/components/LogoMenu.tsx) iterates `menuApps` grouped by `menuGroupOrder` |
| Tab icon + colour | [AppTab.tsx](../src/components/AppTab.tsx) reads `appById[panelId]` |
| Native Tauri **Apps** menu | [lib.rs](../src-tauri/src/lib.rs) `build_apps_menu` reads `apps.json` via `include_str!`, inserts separators between groups |
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
[useIOSessionManager](../src/hooks/useIOSessionManager.ts) and benefit from
adjacency so related tooling is visible at a glance.

## Where things live

| Directory | What's there |
|---|---|
| [../src/styles/colourTokens.ts](../src/styles/colourTokens.ts) | Surfaces, text, borders, status, data accents, hover, interactive |
| [../src/styles/typography.ts](../src/styles/typography.ts) | Headings, body, mono, labels, empty-state, truncation |
| [../src/styles/spacing.ts](../src/styles/spacing.ts) | Padding, gaps, vertical spacing, margins, radius, icon sizes, flex helpers |
| [../src/styles/buttonStyles.ts](../src/styles/buttonStyles.ts) | Button variants, toggle helpers, launcher, dialog options |
| [../src/styles/inputStyles.ts](../src/styles/inputStyles.ts) | Input/select variants, label / help / heights |
| [../src/styles/badgeStyles.ts](../src/styles/badgeStyles.ts) | Standard, small, dark-panel, metadata badges |
| [../src/styles/cardStyles.ts](../src/styles/cardStyles.ts) | Card/alert variants, detail box, panel footer, expandable row, selectable option |
| [../src/styles/index.ts](../src/styles/index.ts) | Single barrel — import from here |
| [../src/locales/en-AU/common.json](../src/locales/en-AU/common.json) | Buttons, generic states, errors, units |
| [../src/locales/en-AU/settings.json](../src/locales/en-AU/settings.json) | Settings panel strings |
| [../src/locales/en-AU/menus.json](../src/locales/en-AU/menus.json) | Logo menu, panel titles |
| [../src/locales/index.ts](../src/locales/index.ts) | Locale registry, supported languages |
| [../src/i18n.ts](../src/i18n.ts) | i18next bootstrap |
| [../src/components/MainLayout.tsx](../src/components/MainLayout.tsx) | Panel registry, dashboard watermark |
| [../src/components/LogoMenu.tsx](../src/components/LogoMenu.tsx) | App launcher menu |
| [../src-tauri/src/lib.rs](../src-tauri/src/lib.rs) | Native Tauri menu, panel-open events |

## Future improvements (non-blocking)

- Optional `<Input />`, `<Select />`, `<Button />` wrappers for places where
  the same prop combinations are used repeatedly. Trade-off: more abstraction,
  slightly less direct control.
- Table primitives — `Table`, `TableRow`, `TableCell` — for data grids that
  currently roll their own.
- Move hardcoded `red-600` / `green-600` inside `dangerButtonBase` and
  `successButtonBase` behind status CSS variables for full theming.
- Populate additional locales (`en-US`, `de`, `ja`, …). Infrastructure is
  ready; add a folder + register in `src/locales/index.ts`.

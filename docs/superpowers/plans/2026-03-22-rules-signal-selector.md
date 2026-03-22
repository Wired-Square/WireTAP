# Rules Signal Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw signal ID inputs in the WireTAP Rules UI with searchable comboboxes showing human-readable signal names, add a user signal creation wizard, fix hex ID rendering, and ensure the board definition stays up-to-date.

**Architecture:** Library-first approach — signal categorisation, name resolution, and board def editing live in framelink-rs. WireTAP's Rust backend wraps library calls as WS commands. The frontend adds a reusable SignalCombobox component used by Generator, Transformer, and Indicator dialogs.

**Tech Stack:** Rust (framelink-rs library + WireTAP Tauri backend), TypeScript/React (WireTAP frontend), Zustand (state management)

**Spec:** `docs/superpowers/specs/2026-03-22-rules-signal-selector-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `framelink-rs/src/board/editable.rs` | `EditableBoardDef` and related types (moved from CLI) |
| `framelink-rs/src/board/selectable.rs` | `SelectableSignal`, `SignalTier`, `list_selectable_signals()` |
| `WireTAP/src/apps/rules/utils/formatHex.ts` | `formatHexId()` utility |
| `WireTAP/src/apps/rules/components/SignalCombobox.tsx` | Searchable signal selector component |
| `WireTAP/src/apps/rules/dialogs/UserSignalDialog.tsx` | User signal creation wizard |

### Modified Files

| File | Changes |
|------|---------|
| `framelink-rs/src/board/mod.rs` | Add `pub mod editable`, `pub mod selectable` |
| `framelink-rs/src/lib.rs` | No change needed (board mod already public) |
| `framelink-rs/src/bin/framelink_cli/board_editor.rs` | Replace local types with library imports |
| `framelink-rs/src/bin/framelink_cli/rules_tui.rs` | Replace inline signal option building with library call |
| `WireTAP/src-tauri/src/io/framelink/rules.rs` | Add `cmd_signals_selectable`, register in dispatch |
| `WireTAP/src-tauri/src/io/framelink/shared.rs` | Add `EditableBoardDef` to `ManagedConnection` |
| `WireTAP/src/api/framelinkRules.ts` | Add `framelinkSignalsSelectable()`, `SelectableSignal` type |
| `WireTAP/src/apps/rules/stores/rulesStore.ts` | Add `selectableSignals` state, loading, refresh |
| `WireTAP/src/apps/rules/dialogs/GeneratorDialog.tsx` | Replace signal ID inputs with SignalCombobox |
| `WireTAP/src/apps/rules/dialogs/TransformerDialog.tsx` | Replace signal ID inputs with SignalCombobox |
| `WireTAP/src/apps/rules/dialogs/IndicatorConfigDialog.tsx` | Replace `<select>` with SignalCombobox |
| `WireTAP/src/apps/rules/views/UserSignalsView.tsx` | Replace hex input with dialog trigger |
| `WireTAP/src/apps/rules/views/DeviceOverview.tsx` | Hex cleanup |
| `WireTAP/src/apps/rules/views/FrameDefsView.tsx` | Hex cleanup |
| `WireTAP/src/apps/rules/views/BridgesView.tsx` | Hex cleanup |
| `WireTAP/src/apps/rules/views/TransformersView.tsx` | Hex cleanup |
| `WireTAP/src/apps/rules/views/GeneratorsView.tsx` | Hex cleanup |
| `WireTAP/src/apps/rules/views/FrameDefEditor.tsx` | Hex cleanup |

---

## Task 1: Move EditableBoardDef to Library

Move `EditableBoardDef` and related types from the CLI (`src/bin/framelink_cli/board_editor.rs`) into the library (`src/board/editable.rs`). Both WireTAP and the CLI need these types.

**Files:**
- Create: `framelink-rs/src/board/editable.rs`
- Modify: `framelink-rs/src/board/mod.rs`
- Modify: `framelink-rs/src/bin/framelink_cli/board_editor.rs`

- [ ] **Step 1:** Create `framelink-rs/src/board/editable.rs` by moving the types (`EditableBoardDef`, `EditableInterface`, `EditablePeripheral`, `EditableSignal`, `EditableFrameDef`, `EditableCanHeader`, `EditableRs485Header`, `EditableFrameSignal`) and the `impl EditableBoardDef` block (methods `from_board_def`, `from_toml`, `to_toml`) from `board_editor.rs`. Update imports to use crate-internal paths (`use crate::board::{BoardDef, FrameDefDisplayInfo}`, `use crate::board::toml_schema::{self, BoardFile, parse_hex_key}`). Add `#[derive(Debug, Clone, Serialize, Deserialize)]` where appropriate.

- [ ] **Step 2:** Add `pub mod editable;` to `framelink-rs/src/board/mod.rs`.

- [ ] **Step 3:** Update `framelink-rs/src/bin/framelink_cli/board_editor.rs` to re-export from the library: replace the local type definitions with `pub use framelink::board::editable::*;` and keep any CLI-specific methods that aren't shared.

- [ ] **Step 4:** Run `cargo build` and `cargo build --features cli` to verify both compile.

- [ ] **Step 5:** Run `cargo test` to verify existing tests pass.

- [ ] **Step 6:** Commit: `"refactor: move EditableBoardDef from CLI to library"`

---

## Task 2: Add SelectableSignal and list_selectable_signals()

Add the library function that queries a device and returns all selectable signals grouped by tier.

**Files:**
- Create: `framelink-rs/src/board/selectable.rs`
- Modify: `framelink-rs/src/board/mod.rs`

- [ ] **Step 1:** Create `framelink-rs/src/board/selectable.rs` with types:

```rust
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SelectableSignal {
    pub signal_id: u16,
    pub name: String,
    pub group: String,
    pub tier: SignalTier,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_def_id: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalTier {
    FrameDef,
    Device,
    User,
}
```

- [ ] **Step 2:** Add a **pure (non-async) categorisation function** that takes pre-fetched data:

```rust
pub fn categorise_signals(
    frame_defs: &[frame_def::FrameDefInfo],
    device_signals: &[dsig::SignalInfo],
    board_def: Option<&BoardDef>,
) -> Vec<SelectableSignal>
```

This categorises:
  - Frame def signals: from `frame_defs`, names from board def's `frame_defs` or generated
  - Device signals: from board def's `signals` HashMap
  - User signals: signals in `device_signals` not found in board def signals or frame def signals

Use `board::display::resolve_signal_name()` for name resolution. Reference `types::FRAME_DEF_ID_DEVICE` and `types::FRAME_DEF_ID_USER` for tier sentinel values.

- [ ] **Step 2a:** Add an **async convenience wrapper** that queries the device and calls the pure function:

```rust
pub async fn list_selectable_signals(
    session: &FrameLinkSession,
    board_def: Option<&BoardDef>,
) -> Result<Vec<SelectableSignal>, ClientError>
```

This fetches frame defs via `session.request_multi(MSG_FRAME_DEF_LIST, ...)` and device signals via `session.request_multi(MSG_DSIG_LIST, ...)`, parses the responses, then calls `categorise_signals()`. The CLI can skip this wrapper and call `categorise_signals()` directly with its cached data.

- [ ] **Step 3:** Add `pub mod selectable;` to `framelink-rs/src/board/mod.rs`.

- [ ] **Step 4:** Write a unit test in `selectable.rs` that constructs a `BoardDef` with known signals, creates mock frame def and dsig data, and verifies the categorisation logic. Test that frame def signals get `tier: FrameDef`, board def signals get `tier: Device`, and unknown signals get `tier: User`.

- [ ] **Step 5:** Run `cargo test` to verify the test passes.

- [ ] **Step 6:** Run `cargo build` to verify full compilation.

- [ ] **Step 7:** Commit: `"feat: add list_selectable_signals() to library"`

---

## Task 3: Update CLI to Use Library Signal Selection

Replace the inline signal option building in `rules_tui.rs` (lines ~2877-2917) with a call to the library function.

**Files:**
- Modify: `framelink-rs/src/bin/framelink_cli/rules_tui.rs`

- [ ] **Step 1:** Find all call sites where signal options are built inline (the three-section block building `signal_options` from frame defs, device signals, and user signals). Replace with a call to `list_selectable_signals()`, then convert the returned `Vec<SelectableSignal>` into `Vec<SelectOption>` for the TUI. The `SelectOption` format uses `label` (e.g., "Signal Name (Group)"), `description` (e.g., "Frame 0x0100"), and `value` (e.g., "256:65281" as `frame_def_id:signal_id`).

- [ ] **Step 2:** Run `cargo build --features cli` to verify compilation.

- [ ] **Step 3:** Commit: `"refactor: CLI uses library list_selectable_signals()"`

---

## Task 4: WireTAP Backend — Selectable Signals Endpoint

Add the `framelink.signals.selectable` WS command handler.

**Files:**
- Modify: `WireTAP/src-tauri/src/io/framelink/rules.rs`

- [ ] **Step 1:** Add `cmd_signals_selectable` handler function. Use the existing `get_host_port()` and `get_timeout()` helpers. Get the managed connection via `shared::ensure_connection()`, load the board def via `shared::load_board_def()`, call `framelink::board::selectable::list_selectable_signals()` on the connection's session, serialise to JSON.

- [ ] **Step 2:** Register `"framelink.signals.selectable" => cmd_signals_selectable(params).await` in `dispatch_framelink_command()` (after the palettes entry, around line 452).

- [ ] **Step 3:** Run `cargo build` from `src-tauri/` to verify compilation.

- [ ] **Step 4:** Commit: `"feat: add framelink.signals.selectable WS command"`

---

## Task 5: WireTAP Backend — EditableBoardDef in ManagedConnection

Add an `EditableBoardDef` cache to the managed connection so signal metadata can be updated and pushed to the device.

**Files:**
- Modify: `WireTAP/src-tauri/src/io/framelink/shared.rs`
- Modify: `WireTAP/src-tauri/src/io/framelink/rules.rs`

- [ ] **Step 1:** Add `editable_board_def: Mutex<Option<framelink::board::editable::EditableBoardDef>>` field to `ManagedConnection` (line ~33). `ManagedConnection` is wrapped in `Arc`, so interior mutability via `Mutex` is required. Initialise it in `ensure_connection()` — after `fetch_capabilities`, if a `BoardDef` was loaded, construct `EditableBoardDef::from_board_def(&board_def)` and wrap in `Mutex::new(Some(...))`.

- [ ] **Step 2:** Add a public helper to access and mutate the board def:

```rust
pub(crate) async fn with_editable_board_def<F, R>(host: &str, port: u16, f: F) -> Result<R, String>
where F: FnOnce(&mut EditableBoardDef) -> R
```

This acquires the connection from the pool, locks the mutex, calls the closure, and returns the result.

- [ ] **Step 3:** Add a helper function to upload the board def to the device after mutations. The upload protocol uses chunked messages via `build_board_def_upload(offset, total_size, data)` from `framelink::protocol::board_def`. Serialise the `EditableBoardDef` to TOML via `to_toml()`, then send in chunks matching the device's max payload size. Add this as a library helper (e.g., `board::editable::upload_board_def(session, editable)`) so both consumers can use it.

- [ ] **Step 5:** Run `cargo build` from `src-tauri/` to verify compilation.

- [ ] **Step 6:** Commit: `"feat: maintain EditableBoardDef in connection pool, sync to device"`

---

## Task 6: formatHexId Utility + Hex Cleanup

Create the hex formatting utility and update all Rules UI views.

**Files:**
- Create: `WireTAP/src/apps/rules/utils/formatHex.ts`
- Modify: 6 view files + 1 dialog (see spec table)

- [ ] **Step 1:** Create `WireTAP/src/apps/rules/utils/formatHex.ts`:

```typescript
/**
 * Format a numeric ID as a hex string with 0x prefix, uppercase, zero-padded.
 * Padding matches the protocol field width (bytes * 2 hex digits).
 */
export function formatHexId(id: number, bytes: number = 2): string {
  return `0x${id.toString(16).toUpperCase().padStart(bytes * 2, "0")}`;
}
```

- [ ] **Step 2:** Update `DeviceOverview.tsx` — import `formatHexId`, replace decimal IDs with hex. These are inside template literals (e.g., `` `Bridge #${b.bridge_id}` `` → `` `Bridge #${formatHexId(b.bridge_id)}` ``). Apply to `bridge_id`, `transformer_id`, and `generator_id`.

- [ ] **Step 3:** Update `FrameDefsView.tsx` — replace `#{fd.frame_def_id}` (JSX text + expression) with `#{formatHexId(fd.frame_def_id)}`.

- [ ] **Step 4:** Update `BridgesView.tsx` — replace `#{b.bridge_id}` with `#${formatHexId(b.bridge_id)}`.

- [ ] **Step 5:** Update `TransformersView.tsx` — replace `#{t.transformer_id}` with `#${formatHexId(t.transformer_id)}`.

- [ ] **Step 6:** Update `GeneratorsView.tsx` — replace `#{g.generator_id}` with `#${formatHexId(g.generator_id)}`.

- [ ] **Step 7:** Update `FrameDefEditor.tsx` — replace `Frame Def #${frameDefId}` with `Frame Def #${formatHexId(frameDefId)}`.

- [ ] **Step 8:** Update `IndicatorConfigDialog.tsx` — replace `Signal ${sig.signal_id}` with `Signal ${formatHexId(sig.signal_id)}` in the signal dropdown label.

- [ ] **Step 9:** Update `UserSignalsView.tsx` — replace the inline hex formatting (`0x{signalId.toString(16).toUpperCase().padStart(4, "0")}`) with `formatHexId(signalId)`.

- [ ] **Step 10:** Run `npx tsc --noEmit` to verify no type errors.

- [ ] **Step 11:** Commit: `"fix: render all Rules UI protocol IDs as hex"`

---

## Task 7: Frontend API + Store — Selectable Signals

Add the API wrapper and store state for selectable signals.

**Files:**
- Modify: `WireTAP/src/api/framelinkRules.ts`
- Modify: `WireTAP/src/apps/rules/stores/rulesStore.ts`

- [ ] **Step 1:** Add `SelectableSignal` type and API wrapper to `framelinkRules.ts`:

```typescript
export interface SelectableSignal {
  signal_id: number;
  name: string;
  group: string;
  tier: "frame_def" | "device" | "user";
  frame_def_id?: number;
}

export function framelinkSignalsSelectable(
  deviceId: string,
): Promise<SelectableSignal[]> {
  return wsTransport.command("framelink.signals.selectable", { device_id: deviceId });
}
```

- [ ] **Step 2:** Add to `rulesStore.ts` state interface:
  - `selectableSignals: SelectableSignal[]` field in `RulesState`
  - `loading.selectableSignals: boolean` in `LoadingState`
  - `loadSelectableSignals: () => Promise<void>` action in `RulesActions`

- [ ] **Step 3:** Add `selectableSignals: []` and `loading.selectableSignals: false` to `initialState`.

- [ ] **Step 4:** Implement `loadSelectableSignals` action — calls `framelinkSignalsSelectable(deviceId())`, sets loading state, stores result.

- [ ] **Step 5:** Call `loadSelectableSignals` at the end of `connectDevice` (after `loadAllTabs()`).

- [ ] **Step 6:** Add `await loadSelectableSignals()` calls after mutations that affect signals: `addFrameDef`, `removeFrameDef`, `addUserSignal`, `removeUserSignal`, `persistLoad`, `persistClear`.

- [ ] **Step 7:** Add `loadSelectableSignals` to the `loadAllTabs` function (or call it separately after — it's a different endpoint than the per-tab loads).

- [ ] **Step 8:** Run `npx tsc --noEmit` to verify no type errors.

- [ ] **Step 9:** Commit: `"feat: add selectable signals API and store state"`

---

## Task 8: SignalCombobox Component

Create the searchable signal selector component.

**Files:**
- Create: `WireTAP/src/apps/rules/components/SignalCombobox.tsx`

- [ ] **Step 1:** Create the component with props:

```typescript
interface SignalComboboxProps {
  signals: SelectableSignal[];
  value: number | null;
  onChange: (signalId: number) => void;
  placeholder?: string;
}
```

- [ ] **Step 2:** Implement the component structure:
  - Text input that shows the selected signal's name (or hex ID if not found)
  - On focus/click, open a dropdown panel (use `position: fixed` with `useRef` for positioning to escape table cell overflow)
  - Filter state: typing filters signals by name (case-insensitive substring) OR hex signal ID (strip `0x` prefix, match against hex representation)
  - Group signals by tier header ("Frame Definition Signals", "Device Signals", "User Signals"), then by `group` within each tier
  - Each option: signal name in primary text, `formatHexId(signal_id)` and group in muted text
  - Click selects, Escape/blur closes
  - If typed text is a valid hex number and no signal matches, allow manual entry (parse hex, call onChange)

- [ ] **Step 3:** Style using existing WireTAP CSS variable tokens (`textPrimary`, `bgSurface`, `borderDefault`, etc. from `src/styles/`). Use `textSecondary` for group labels and hex IDs. Use compact sizing (`text-xs`, `py-1 px-2`) to fit in table cells.

- [ ] **Step 4:** Run `npx tsc --noEmit` to verify no type errors.

- [ ] **Step 5:** Commit: `"feat: add SignalCombobox searchable signal selector"`

---

## Task 9: Update GeneratorDialog

Replace raw signal ID inputs with SignalCombobox.

**Files:**
- Modify: `WireTAP/src/apps/rules/dialogs/GeneratorDialog.tsx`

- [ ] **Step 1:** Import `SignalCombobox` and `useRulesStore`. Add `const selectableSignals = useRulesStore((s) => s.selectableSignals);` to the component.

- [ ] **Step 2:** Replace the `<input type="number">` for `source_signal_id` (lines ~205-207) with `<SignalCombobox signals={selectableSignals} value={m.source_signal_id || null} onChange={(id) => updateMapping(idx, "source_signal_id", id)} placeholder="Source signal" />`.

- [ ] **Step 3:** Replace the `<input type="number">` for `dest_signal_id` (lines ~215-217) with the same pattern.

- [ ] **Step 4:** Run `npx tsc --noEmit` to verify no type errors.

- [ ] **Step 5:** Commit: `"feat: GeneratorDialog uses SignalCombobox for signal selection"`

---

## Task 10: Update TransformerDialog

Replace raw signal ID inputs with SignalCombobox.

**Files:**
- Modify: `WireTAP/src/apps/rules/dialogs/TransformerDialog.tsx`

- [ ] **Step 1:** Import `SignalCombobox` and `useRulesStore`. Add `const selectableSignals = useRulesStore((s) => s.selectableSignals);`.

- [ ] **Step 2:** Replace `<input type="number">` for `source_signal_id` (lines ~214-216) with `<SignalCombobox>`.

- [ ] **Step 3:** Replace `<input type="number">` for `dest_signal_id` (lines ~224-226) with `<SignalCombobox>`.

- [ ] **Step 4:** Run `npx tsc --noEmit` to verify no type errors.

- [ ] **Step 5:** Commit: `"feat: TransformerDialog uses SignalCombobox for signal selection"`

---

## Task 11: Update IndicatorConfigDialog

Replace the existing `<select>` signal dropdown with SignalCombobox for consistency.

**Files:**
- Modify: `WireTAP/src/apps/rules/dialogs/IndicatorConfigDialog.tsx`

- [ ] **Step 1:** Import `SignalCombobox` and `useRulesStore`. Add store selector for `selectableSignals`.

- [ ] **Step 2:** Remove the inline `signalOptions` construction (lines ~131-140 that builds options from `frameDefs`). Replace the `<select>` element with `<SignalCombobox>` using the store's `selectableSignals`.

- [ ] **Step 3:** The existing value format is `"frame_def_id:signal_id"` — update the `onChange` handler to work with the SignalCombobox's `number` output (just the signal_id). Adjust how the selected signal is resolved for the indicator configure command.

- [ ] **Step 4:** Run `npx tsc --noEmit` to verify no type errors.

- [ ] **Step 5:** Commit: `"feat: IndicatorConfigDialog uses SignalCombobox"`

---

## Task 12: UserSignalDialog + UserSignalsView Update

Create the user signal creation wizard and update the view to use it.

**Files:**
- Create: `WireTAP/src/apps/rules/dialogs/UserSignalDialog.tsx`
- Modify: `WireTAP/src/apps/rules/views/UserSignalsView.tsx`
- Modify: `WireTAP/src/apps/rules/stores/rulesStore.ts`

- [ ] **Step 1:** Create `UserSignalDialog.tsx` with fields:
  - Signal ID: hex text input (required)
  - Name: text input (required, e.g., "Coolant Temperature")
  - Group: text input (default "User")
  - Format: dropdown — `number`, `bool`, `enum`, `color_brgb`, `temperature_0.1`
  - Unit: text input (optional, e.g., "°C")
  - Enum values: dynamic key-value rows (shown when format is "enum", value number → label string)

  Use the existing `Dialog` component from `src/components/Dialog.tsx`. Style with CSS variable tokens.

- [ ] **Step 2:** Update `addUserSignal` in `rulesStore.ts` to accept metadata (name, group, format, unit, enum_values) in addition to the signal ID. Pass this metadata to the backend so it can update the EditableBoardDef. Update the `framelinkUserSignalAdd` API wrapper to accept and forward the metadata params.

- [ ] **Step 3:** Update `UserSignalsView.tsx`:
  - Remove the inline hex input and `handleAdd` logic
  - Add state for dialog open: `const [dialogOpen, setDialogOpen] = useState(false)`
  - Replace the input with an "Add Signal" button that opens `UserSignalDialog`
  - The dialog's onSubmit calls `addUserSignal` with the full metadata
  - Display existing user signals from `selectableSignals` filtered to `tier === "user"` (shows name + hex ID)

- [ ] **Step 4:** Run `npx tsc --noEmit` to verify no type errors.

- [ ] **Step 5:** Commit: `"feat: user signal creation wizard with metadata"`

---

## Task 13: Backend — User Signal Metadata Forwarding

Update the backend `cmd_user_signal_add` to accept signal metadata and update the EditableBoardDef.

**Files:**
- Modify: `WireTAP/src-tauri/src/io/framelink/rules.rs`

- [ ] **Step 1:** Update `cmd_user_signal_add` to parse optional metadata fields from params: `name` (string), `group` (string), `format` (string), `unit` (string), `enum_values` (map of u32 → string).

- [ ] **Step 2:** After sending `MSG_USER_SIGNAL_ADD` to the device, if metadata is provided, get the `ManagedConnection` from the pool, insert a new `EditableSignal` into the `EditableBoardDef`'s `signals` map with the provided metadata.

- [ ] **Step 3:** After updating the `EditableBoardDef`, upload to the device using the `upload_board_def()` library helper added in Task 5 Step 3.

- [ ] **Step 4:** Run `cargo build` from `src-tauri/` to verify compilation.

- [ ] **Step 5:** Commit: `"feat: user signal metadata stored in board def and uploaded to device"`

---

## Execution Order

Tasks can be partially parallelised:

```
Task 1 (EditableBoardDef → library)
  ↓
Task 2 (SelectableSignal + list function)
  ↓
Task 3 (CLI migration)    Task 4 (WireTAP backend endpoint)    Task 5 (backend board def cache)
                                    ↓
Task 6 (formatHexId + hex cleanup)  Task 7 (API + store)
                                    ↓
Task 8 (SignalCombobox component)
  ↓
Task 9 (GeneratorDialog)  Task 10 (TransformerDialog)  Task 11 (IndicatorConfigDialog)
  ↓
Task 12 (UserSignalDialog)  Task 13 (Backend metadata)
```

Tasks 1→2 are sequential (library foundation). After that, Tasks 3, 4, 5 can proceed in parallel. Tasks 6 and 7 can proceed in parallel. Tasks 9, 10, 11 can proceed in parallel after 8. Tasks 12 and 13 can proceed in parallel.

# Rules UI: Searchable Signal Selection and Hex ID Consistency

**Date:** 2026-03-22
**Scope:** WireTAP Rules UI (`src/apps/rules/`), Rust backend (`src-tauri/src/io/framelink/`)

## Problem

Generator and Transformer dialogs require users to enter raw numeric signal IDs manually. Users must know IDs by heart — there are no human-readable labels or searchable lists. Additionally, protocol IDs throughout the Rules UI render inconsistently (some decimal, some hex).

The FrameLink device exposes signals from three tiers:
- **Frame def signals** — signals within CAN frame definitions (e.g., vehicle speed, engine RPM)
- **Device signals** — hardware configuration signals (e.g., CAN bitrate, LED colour)
- **User signals** — user-created virtual signals for inter-rule communication

All three tiers should be selectable with human-readable names. The board definition (TOML) provides the signal-to-name mapping and must be kept up-to-date when new frame definitions or user signals are created.

## Design

### 1. Library: Selectable Signal List (framelink-rs)

The signal categorisation, tier classification, name resolution, and diffing logic all belong in the framelink-rs library — both the CLI and WireTAP need this capability.

**New library types** (e.g., `src/board/selectable.rs`):

```rust
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

**New library function:**

```rust
pub async fn list_selectable_signals(
    session: &FrameLinkSession,
    board_def: Option<&BoardDef>,
) -> Result<Vec<SelectableSignal>, FrameLinkError>
```

This function queries the device and builds the three-tier list:

1. **Frame def signals** — query device via `MSG_FRAME_DEF_LIST`, extract each signal. Names resolved from board def's `frame_defs` HashMap where available, otherwise generated (e.g., "Signal 0x0010").
2. **Device signals** — enumerate the board def's `signals` HashMap directly. These are static hardware config signals defined in the TOML (CAN bitrate, LED colours, etc.). No device query needed.
3. **User signals** — query device via `MSG_DSIG_LIST`, then diff against the board def's known device signals. Any signal ID in the device list that is NOT in the board def's `signals` HashMap and NOT a signal within a known frame def is classified as a user signal. Names from board def where available, otherwise generated (e.g., "User Signal 0x0100").

### 2. Backend: `framelink.signals.selectable` WS Command

A thin WireTAP wrapper that calls the library function and serialises the result.

**Handler in `rules.rs`:**
```rust
async fn cmd_signals_selectable(params: Value) -> Result<Value, String> {
    let (host, port) = get_host_port(&params).await?;
    let conn = shared::ensure_connection(&host, port, ...).await?;
    let board_def = shared::load_board_def(&host, port).await;
    let signals = framelink::board::selectable::list_selectable_signals(
        &conn.session,
        board_def.as_ref(),
    ).await.map_err(|e| e.to_string())?;
    serde_json::to_value(&signals).map_err(|e| e.to_string())
}
```

**Registration:** Add `"framelink.signals.selectable" => cmd_signals_selectable(params).await` to `dispatch_framelink_command()`.

**Request:**
```json
{ "device_id": "WiredFlexLink-9D04" }
```

**Response:**
```json
[
  {
    "signal_id": 16,
    "name": "Speed",
    "group": "Vehicle (0x0100)",
    "tier": "frame_def",
    "frame_def_id": 256
  },
  {
    "signal_id": 65280,
    "name": "CAN0 Bitrate",
    "group": "CAN0",
    "tier": "device"
  },
  {
    "signal_id": 256,
    "name": "User Signal 0x0100",
    "group": "User",
    "tier": "user"
  }
]
```

**After mutations:** The frontend refreshes by re-calling `framelink.signals.selectable`. Since the library function queries live device state each time, new frame def signals and user signals appear immediately. No backend cache invalidation required.

### 2a. CLI: Migrate to Library Signal Selection

The framelink-rs CLI (`rules_tui.rs`) currently builds its own three-tier signal option list inline (lines ~2877-2917) using local logic to enumerate frame def signals, device signals, and user signals. This should be replaced with a call to the new `list_selectable_signals()` library function, converting the returned `Vec<SelectableSignal>` into the TUI's `SelectOption` format.

The CLI's locally tracked `Vec<UserSignalEntry>` remains for TUI state, but signal option building for transformer/generator/user-signal wizards uses the library function instead of duplicating the categorisation logic.

### 3. Frontend Store: Selectable Signals

Add to `rulesStore`:

```typescript
interface SelectableSignal {
  signal_id: number;
  name: string;
  group: string;
  tier: "frame_def" | "device" | "user";
  frame_def_id?: number;
}
```

**State:**
- `selectableSignals: SelectableSignal[]` — loaded on connect, refreshed after mutations

**Loading:**
- On connect: after `loadAllTabs()`, call `framelink.signals.selectable`
- After frame def add/remove: refresh selectable signals
- After user signal add/remove: refresh selectable signals
- After persist load/clear: refresh selectable signals
- NOT on tab switch (data already loaded)

### 4. Frontend Component: `SignalCombobox`

A shared searchable combobox component for signal selection. Located at `src/apps/rules/components/SignalCombobox.tsx`.

**Props:**
```typescript
interface SignalComboboxProps {
  signals: SelectableSignal[];
  value: number | null;           // Selected signal_id
  onChange: (signalId: number) => void;
  placeholder?: string;
}
```

**Behaviour:**
- Text input with dropdown panel
- Typing filters the list — matches against both **signal name** (substring, case-insensitive) and **hex signal ID** (e.g., typing "FF00" or "0xFF00" matches signal `0xFF00`)
- Signals grouped by tier header ("Frame Def Signals", "Device Signals", "User Signals"), then by `group` within each tier
- Each option displays: **Signal Name** with `0xNNNN` ID and group in muted text
- Selecting an option sets the signal ID and displays the name in the input
- Allows manual hex entry for signals not in the list (edge case for uncatalogued signals)
- Follows existing WireTAP styling (CSS variable tokens, not Tailwind `dark:` variants)

### 5. Dialog Changes

**GeneratorDialog.tsx:**
- Replace `<input type="number">` for `source_signal_id` and `dest_signal_id` in mapping rows with `SignalCombobox`
- Pass `selectableSignals` from the rules store

**TransformerDialog.tsx:**
- Same treatment for signal mapping inputs

**IndicatorConfigDialog.tsx:**
- Replace the existing `<select>` signal dropdown with `SignalCombobox` for consistency (currently builds its own option list from frame defs only — missing device and user signals)

### 6. Hex ID Rendering Cleanup

All protocol IDs in the Rules UI rendered as hex with `0x` prefix, uppercase, zero-padded to the field's protocol width.

**Padding rules:**
- 1-byte fields (interface index): 2 hex digits → `0x0F`
- 2-byte fields (signal_id, frame_def_id, bridge_id, transformer_id, generator_id): 4 hex digits → `0x00FF`

**Utility function** in `src/apps/rules/utils/formatHex.ts`:
```typescript
export function formatHexId(id: number, bytes: number = 2): string {
  return `0x${id.toString(16).toUpperCase().padStart(bytes * 2, "0")}`;
}
```

**Files to update:**

| File | Field | Current | Target |
|------|-------|---------|--------|
| DeviceOverview.tsx | bridge_id | `#${b.bridge_id}` | `#${formatHexId(b.bridge_id)}` |
| DeviceOverview.tsx | transformer_id | `#${t.transformer_id}` | `#${formatHexId(t.transformer_id)}` |
| DeviceOverview.tsx | generator_id | `#${g.generator_id}` | `#${formatHexId(g.generator_id)}` |
| FrameDefsView.tsx | frame_def_id | `#${fd.frame_def_id}` | `#${formatHexId(fd.frame_def_id)}` |
| BridgesView.tsx | bridge_id | `#${b.bridge_id}` | `#${formatHexId(b.bridge_id)}` |
| TransformersView.tsx | transformer_id | `#${t.transformer_id}` | `#${formatHexId(t.transformer_id)}` |
| GeneratorsView.tsx | generator_id | `#${g.generator_id}` | `#${formatHexId(g.generator_id)}` |
| IndicatorConfigDialog.tsx | signal_id | `Signal ${sig.signal_id}` | `Signal ${formatHexId(sig.signal_id)}` |
| FrameDefEditor.tsx | frame_def_id | `Frame Def #${frameDefId}` | `Frame Def #${formatHexId(frameDefId)}` |

### 7. Library: Move `EditableBoardDef` from CLI to Library

The CLI's `board_editor.rs` contains `EditableBoardDef` — a mutable board definition model with `from_board_def()`, `from_toml()`, and `to_toml()` serialisation. This needs to move into the framelink-rs library (`src/board/editable.rs`) so both WireTAP and the CLI can use it.

**Types to move:**
- `EditableBoardDef` — top-level mutable board def
- `EditableSignal` — signal metadata (name, group, unit, format, enum_values)
- `EditableInterface`, `EditablePeripheral`
- `EditableFrameDef`, `EditableCanHeader`, `EditableRs485Header`, `EditableFrameSignal`

**Methods to move:**
- `from_board_def(bd: &BoardDef)` — construct from immutable board def
- `from_toml(toml_str: &str)` — parse from TOML string
- `to_toml(&self)` — serialise back to TOML

The CLI's `board_editor.rs` becomes a thin wrapper that imports from the library.

### 8. User Signal Creation Wizard

Replace the current raw hex input in `UserSignalsView` with a proper creation dialog (`UserSignalDialog.tsx`) that captures full signal metadata for the board def. This metadata is not sent to the device — it's used by the CLI and WireTAP to correctly render signal values when retrieved.

**Fields:**
- **Signal ID** — hex input (required)
- **Name** — human-readable label (required, e.g., "Coolant Temperature")
- **Group** — logical grouping (default "User", or custom text input, e.g., "Engine")
- **Format** — dropdown: `number`, `bool`, `enum`, `color_brgb`, `temperature_0.1` (default "number")
- **Unit** — optional text (e.g., "°C", "bps", "mA")
- **Enum values** — dynamic key-value rows, shown when format is "enum" (value → label mapping)

**On create:**
1. Send `MSG_USER_SIGNAL_ADD` to device (existing flow)
2. Update the in-memory `EditableBoardDef` with the new signal entry
3. Refresh selectable signals so the new signal appears with its name immediately

### 9. Board Def Persistence

When signal metadata is added via the user signal wizard or frame def creation, the updated board def must be persisted. The device can store its own TOML copy (via the existing `board upload` protocol message).

**Approach:**
- Maintain an in-memory `EditableBoardDef` in the backend's `ManagedConnection` (constructed from the device's TOML if available, otherwise from embedded defaults)
- When user signals or frame defs are created, update the `EditableBoardDef` with new entries
- After updates, push the serialised TOML to the device via `MSG_BOARD_DEF_UPLOAD` so the board def persists across device reboots
- The `list_selectable_signals()` library function reads from this up-to-date board def

## Files Touched (updated)

### New Files (Library)
- `framelink-rs/src/board/editable.rs` — `EditableBoardDef` and related types (moved from CLI)
- `framelink-rs/src/board/selectable.rs` — `SelectableSignal`, `SignalTier`, `list_selectable_signals()`

### New Files (WireTAP)
- `src/apps/rules/components/SignalCombobox.tsx` — searchable signal selector component
- `src/apps/rules/dialogs/UserSignalDialog.tsx` — user signal creation wizard
- `src/apps/rules/utils/formatHex.ts` — hex formatting utility

### Modified Files

**framelink-rs Library:**
- `src/board/mod.rs` — add `pub mod editable`, `pub mod selectable`, re-export types

**framelink-rs CLI:**
- `src/bin/framelink_cli/board_editor.rs` — import from library instead of defining locally
- `src/bin/framelink_cli/rules_tui.rs` — replace inline signal option building with `list_selectable_signals()`

**WireTAP Backend:**
- `src-tauri/src/io/framelink/rules.rs` — new `cmd_signals_selectable` handler, register in dispatch
- `src-tauri/src/io/framelink/shared.rs` — maintain `EditableBoardDef` in `ManagedConnection`, update on signal/frame def creation

**Frontend API:**
- `src/api/framelinkRules.ts` — new `framelinkSignalsSelectable()` wrapper, `SelectableSignal` type

**Frontend Store:**
- `src/apps/rules/stores/rulesStore.ts` — `selectableSignals` state, load on connect, refresh after mutations

**Frontend Dialogs:**
- `src/apps/rules/dialogs/GeneratorDialog.tsx` — replace signal ID inputs with `SignalCombobox`
- `src/apps/rules/dialogs/TransformerDialog.tsx` — replace signal ID inputs with `SignalCombobox`
- `src/apps/rules/dialogs/IndicatorConfigDialog.tsx` — replace `<select>` with `SignalCombobox`

**Frontend Views:**
- `src/apps/rules/views/UserSignalsView.tsx` — replace hex input with "Add Signal" button opening `UserSignalDialog`
- `src/apps/rules/views/DeviceOverview.tsx` — hex cleanup
- `src/apps/rules/views/FrameDefsView.tsx` — hex cleanup
- `src/apps/rules/views/BridgesView.tsx` — hex cleanup
- `src/apps/rules/views/TransformersView.tsx` — hex cleanup
- `src/apps/rules/views/GeneratorsView.tsx` — hex cleanup
- `src/apps/rules/views/FrameDefEditor.tsx` — hex cleanup

## Out of Scope

- Board definition editing UI (full TOML editor for interfaces, peripherals, frame def signals) — this spec only covers adding signal metadata during creation flows
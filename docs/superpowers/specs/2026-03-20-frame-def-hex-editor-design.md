# Frame Definition Hex Editor

## Overview

A visual bit-level editor for frame definitions, integrated into the Rules app's Frame Defs tab. Translates the CLI TUI's hex editor concept to a web UI with click-based interactions. Supports CAN (8 bytes), CAN FD (64 bytes), and serial frame types (up to 512 bytes).

## Navigation Flow

1. **Frame Defs list** (existing view) — shows cards with enriched names. Clicking a card opens the editor for that frame def. "Add Frame Def" button opens a stripped-down creation dialog (interface type, CAN ID/DLC or payload length only — no signal fields), then transitions to the editor with an empty grid.
2. **Hex Editor view** — replaces the card list within the Frame Defs tab via conditional rendering in `FrameDefsView` (local state `editingFrameDef`, not URL routing or store state). The Rules tab bar remains visible. A header bar provides "Back" (discard) and "Save" (send to device) buttons. Clicking "Back" returns to the list.

### Existing FrameDefDialog

The current `FrameDefDialog` is modified to only collect header fields (interface type, CAN ID, DLC/payload length). Its signal table is removed — signal creation moves entirely to the hex editor. On submit, the dialog passes the header info to `FrameDefsView`, which opens the editor with an empty grid.

## Editor Layout

Grid + signal list stacked on the left (flex: 2), properties panel on the right (flex: 1).

### Left Side

**Bit Grid:**
- Byte rows with 8 bit columns displayed 7..0 (MSB to LSB), matching the TUI convention.
- Each bit cell is clickable. Colour-coded by signal ownership. Unassigned bits shown muted.
- Hover highlights the individual bit under the cursor.
- Selection: click an unassigned bit to set anchor (yellow highlight), click a second bit to complete the range. If the range overlaps an existing signal, highlight in red and prevent placement.
- Clicking a bit that belongs to an existing signal selects that signal (no anchor set).
- Clicking the byte offset label (row header) selects the entire byte (8 bits) as a shortcut — equivalent to anchor + complete in one action.
- **Cancel anchor**: click the anchor bit again, or press Escape, to clear the pending selection.
- Grid scrolls vertically for large frames. Visible scrollbar.
- Byte offset input field in the grid header for quick navigation (type a byte number, grid scrolls to it). Useful for 512-byte frames.

**Signal List:**
- Below the grid. Shows all placed signals with: colour dot, name, bit range (e.g. "bit0:8"), byte order abbreviation (LE/BE).
- Clicking a signal selects it: highlights its bits in the grid, scrolls grid to show it, populates properties panel.
- Selected signal has a distinct highlight style.
- Empty state: "No signals defined. Click bits in the grid to add signals."

### Right Side

**Signal Properties Panel:**
- Shown when a signal is selected (from grid click or signal list click).
- Editable fields:
  - **Name** — text input
  - **Start Bit / Length** — read-only display (set by grid selection)
  - **Byte Order** — dropdown: Little Endian, Big Endian
  - **Value Type** — dropdown: Unsigned, Signed, Float, Bool, Array
  - **Scale** — number input (default 1.0)
  - **Offset** — number input (default 0.0)
- "Delete Signal" button at bottom. Also triggered by Delete/Backspace key when a signal is selected.
- When no signal is selected: instructions ("Click two bits in the grid to define a signal range, or click a byte label to select a whole byte.").
- After a new range is selected: panel shows defaults with the name field focused. Signal is committed to the grid immediately with default values; user edits properties inline.

## Frame Types and Payload Sizes

| Interface Type | Payload Size | Header Fields |
|---------------|-------------|---------------|
| CAN | 1–8 bytes (DLC) | CAN ID (hex), DLC, Extended flag |
| CAN FD | 1–64 bytes (DLC) | CAN ID (hex), DLC, Extended flag |
| RS-485 | 1–512 bytes (user-specified) | Framing mode, Payload length |
| RS-232 | 1–512 bytes (user-specified) | Framing mode, Payload length |
| LIN | 1–512 bytes (user-specified) | Framing mode, Payload length |

### Payload Size for Editing Existing Serial Frame Defs

The protocol's `FrameHeader::Rs485 { framing_mode }` does not carry a payload length. For CAN/CAN FD, payload size comes from DLC. For serial types when editing an existing frame def:

- Compute from signals: `ceil(max(start_bit + bit_length) / 8)` across all signals, with a minimum of 64 bytes.
- If no signals exist, default to 64 bytes.
- The user can always add signals beyond the initial grid size — the grid grows to accommodate.

This avoids needing a backend descriptor change. The creation dialog collects the payload length for new serial frame defs.

## Signal ID Assignment

Signal IDs (`signal_id: u16`) are auto-assigned:

- **New signals**: start at `0x0001` and increment. Skip IDs already in use within this frame def. Matches the TUI's `next_frame_signal_id()` logic.
- **Editing existing frame defs**: preserve the original signal IDs from the device. New signals added during editing get the next available ID.
- Signal IDs are not user-editable — they are internal protocol identifiers, not meaningful to the user.

## Interactions

### Adding a Signal
1. Click an unassigned bit in the grid → anchor set (yellow highlight).
2. Click a second bit → range normalised to `(min, max - min + 1)`. Overlap check uses actual bit positions (accounting for byte order of existing signals via the bit ownership map). If overlapping, shown in red; click is rejected.
3. Signal created with next available ID, next colour, and default properties (LE, unsigned, scale 1.0, offset 0.0). Properties panel populates with name field focused.
4. User edits name and properties inline.

### Whole-Byte Shortcut
Click the byte offset label (e.g. "0:", "1:") to select all 8 bits of that byte in one action. If any bit in the byte is already assigned, the click selects the owning signal instead.

### Editing a Signal
1. Click signal bits in the grid, or click signal in the signal list.
2. Properties panel shows current values, all editable.
3. Changes apply immediately to the in-memory state (not sent to device until Save).
4. Changing a signal's bit range requires deleting and re-creating it (intentional limitation, matching the TUI).

### Deleting a Signal
1. Select signal (grid or list click).
2. Click "Delete Signal" in properties panel, or press Delete/Backspace key.
3. Signal removed from grid and list. Bits return to unassigned state.

### Cancelling a Selection
- Click the anchor bit again to deselect it.
- Press Escape to clear the pending anchor.
- Escape with no anchor and no selection returns focus to the signal list.

### Saving
- "Save" button in the header bar.
- For new frame defs: sends `framelink.frame_def.add` WS command.
- For existing frame defs: sends `framelink.frame_def.remove` then `framelink.frame_def.add` (same ID). The protocol has no update message; remove + re-add is transparent to the user.
- On success: returns to list view, list refreshes.
- On error: shows error message, stays in editor.

#### Serialisation Format

The editor state is serialised to match the existing `framelinkFrameDefAdd()` API:

```json
{
  "frame_def_id": 1,
  "interface_type": 1,
  "can_id": 256,
  "dlc": 8,
  "extended": false,
  "signals": [
    {
      "signal_id": 1,
      "start_bit": 0,
      "bit_length": 8,
      "byte_order": 0,
      "value_type": 0,
      "scale": 1.0,
      "offset": 0.0
    }
  ]
}
```

For serial types, `can_id`, `dlc`, and `extended` are omitted; `framing_mode` is included instead.

### Cancel / Back
- "Back" button in header bar.
- If dirty (unsaved changes): show confirmation ("Discard unsaved changes?").
- Returns to frame defs list.

## Validation

Applied when placing a signal (after range selection):

| Rule | Condition | Behaviour |
|------|-----------|-----------|
| Overlap | Range includes bits owned by another signal | Red highlight, placement rejected |
| Bool | Value type is Bool but bit_length ≠ 1 | Inline error on value type field |
| Float | Value type is Float but bit_length ≠ 32 | Inline error on value type field |
| Array | Value type is Array but bit_length not multiple of 8 | Inline error on value type field |
| Name | Name is empty | Save disabled, inline hint on name field |

Validation of value type constraints happens when the user changes the value type dropdown — if the current bit range is incompatible, show an inline error and prevent saving.

## Bit Ownership and Byte Order

The bit ownership map (`bitOwnerMap: Array<number | null>` of length `payloadBytes * 8`) maps each bit position to the owning signal index. This map is computed using the actual bit positions for each signal, accounting for byte order:

- **Little Endian signals**: bits are contiguous from `startBit` to `startBit + bitLength - 1`.
- **Big Endian (Motorola) signals**: bits follow the Motorola bit-snaking layout. The library's `signal_bit_positions()` / `motorola_bit_positions()` functions define this mapping. The web editor replicates this logic in TypeScript.

The ownership map is used for:
- Grid rendering (colouring each bit cell)
- Overlap detection when placing new signals
- Click-to-select (determining which signal owns a clicked bit)

When a Big Endian signal is selected, its non-contiguous bits in the grid are all highlighted in the signal's colour, correctly reflecting the Motorola layout.

## Colour Palette

8 signal colours, assigned in order and cycling. Defined as CSS custom properties for theme compatibility:

```css
--signal-colour-0: #22d3ee; /* cyan */
--signal-colour-1: #4ade80; /* green */
--signal-colour-2: #facc15; /* yellow */
--signal-colour-3: #c084fc; /* magenta */
--signal-colour-4: #60a5fa; /* blue */
--signal-colour-5: #f87171; /* red */
--signal-colour-6: #67e8f9; /* light cyan */
--signal-colour-7: #86efac; /* light green */
```

Added to the existing theme CSS. Each signal's colour is used in both the grid and the signal list for visual coherence.

## Components

| Component | File | Purpose |
|-----------|------|---------|
| `FrameDefEditor` | `src/apps/rules/views/FrameDefEditor.tsx` | Top-level: layout, save/cancel, state management |
| `BitGrid` | `src/apps/rules/components/BitGrid.tsx` | Bit grid rendering, click handling, selection highlighting |
| `SignalList` | `src/apps/rules/components/SignalList.tsx` | Signal list with colour dots, click to select |
| `SignalProperties` | `src/apps/rules/components/SignalProperties.tsx` | Editable properties form |
| `FrameDefsView` | (existing, modified) | Conditional rendering: list vs editor, routes between them |
| `FrameDefDialog` | (existing, modified) | Stripped to header-only fields, no signal table |

## State Management

Editor state is local to `FrameDefEditor` via `useReducer`. This is transient editor state, not shared across the app — no Zustand store needed. `FrameDefsView` holds `editingFrameDef: { frameDefId, interfaceType, header, signals } | null` in local state to toggle between list and editor views.

```typescript
interface EditorState {
  frameDefId: number;
  interfaceType: number;
  header: FrameHeader;
  payloadBytes: number;
  signals: PlacedSignal[];
  selectionAnchor: number | null;
  selectedSignalIndex: number | null;
  dirty: boolean;
}

type FrameHeader =
  | { type: "can"; canId: number; dlc: number; extended: boolean }
  | { type: "serial"; framingMode: number };

interface PlacedSignal {
  signalId: number;
  name: string;
  startBit: number;
  bitLength: number;
  byteOrder: number; // 0 = LE, 1 = BE
  valueType: number; // 0 = unsigned, 1 = signed, 2 = float, 3 = bool, 4 = array
  scale: number;
  offset: number;
  colour: string; // CSS custom property reference
}
```

### Initialisation

- **New frame def**: empty signals array, `frameDefId` from `nextId`, header from creation dialog, `payloadBytes` from DLC (CAN) or user-specified length (serial).
- **Edit existing**: populate signals from `FrameDefDescriptor.signals` (map `SignalDefDescriptor` to `PlacedSignal`, preserving signal IDs), assign colours in order. `payloadBytes` from DLC (CAN) or inferred from signals (serial, minimum 64).

## Backend

No backend changes required. The existing WS commands handle everything:
- `framelink.frame_def.list` — returns enriched `FrameDefDescriptor` with signal names
- `framelink.frame_def.add` — adds a frame def to the device
- `framelink.frame_def.remove` — removes a frame def by ID

The frontend constructs the frame def payload from editor state, matching the existing `framelinkFrameDefAdd()` API wrapper.

## Large Frame Handling (64–512 bytes)

For CAN FD (64 bytes) and serial (up to 512 bytes), the bit grid can be very tall. Mitigations:

- **Scrolling**: grid container has a fixed max-height with overflow-y scroll and visible scrollbar.
- **Jump-to-byte**: input field in the grid header. Type a byte offset, grid scrolls to that row.
- **Signal navigation**: clicking a signal in the signal list scrolls the grid to show that signal's bits.
- **Compact rows**: each byte row is a fixed height (approx 24px). At 512 bytes, the full grid is ~12,288px tall — scrolling is essential.
- **Bit ownership map**: memoised via `useMemo` keyed on `signals`. At 512 bytes (4,096 bits / DOM cells) this is within reasonable limits without virtualisation.

## Keyboard Shortcuts

| Key | Context | Action |
|-----|---------|--------|
| Escape | Anchor set | Clear pending anchor |
| Escape | Signal selected, no anchor | Deselect signal |
| Delete / Backspace | Signal selected | Delete selected signal |

## Out of Scope

- Undo/redo — not in the TUI, not needed here.
- Copy/paste signals between frame defs.
- Drag-to-resize signals in the grid.
- Changing a signal's bit range without delete + re-create.

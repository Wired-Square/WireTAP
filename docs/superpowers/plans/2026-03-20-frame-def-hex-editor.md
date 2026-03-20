# Frame Definition Hex Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visual bit-level hex editor for frame definitions in the Rules app, matching the CLI TUI concept with click-based web interactions.

**Architecture:** New `FrameDefEditor` view with three sub-components (BitGrid, SignalList, SignalProperties) using local `useReducer` state. `FrameDefsView` conditionally renders either the card list or the editor. The existing `FrameDefDialog` is stripped to header-only fields.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4 with CSS variable tokens, existing WS transport API

**Spec:** `docs/superpowers/specs/2026-03-20-frame-def-hex-editor-design.md`

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/WireTAP.css` | Modify | Add signal colour CSS variables |
| `src/apps/rules/utils/bitGrid.ts` | Create | Pure utility functions: bit ownership map, overlap detection, Motorola bit positions, signal ID assignment, signal colour palette, validation |
| `src/apps/rules/components/BitGrid.tsx` | Create | Bit grid rendering with click handling and selection state |
| `src/apps/rules/components/SignalList.tsx` | Create | Signal list with colour dots, click to select |
| `src/apps/rules/components/SignalProperties.tsx` | Create | Editable signal properties form |
| `src/apps/rules/views/FrameDefEditor.tsx` | Create | Top-level editor: layout, useReducer, save/cancel, wiring |
| `src/apps/rules/views/FrameDefsView.tsx` | Modify | Conditional rendering: list vs editor |
| `src/apps/rules/dialogs/FrameDefDialog.tsx` | Modify | Strip signal table, add payload length for serial types, fix isCan detection |

---

### Task 1: Signal colour CSS variables

**Files:**
- Modify: `src/WireTAP.css`

- [ ] **Step 1: Add signal colour variables**

Add the signal colour block inside the `.dark { }` section (after the existing `--status-cyan-*` block around line 419):

```css
  /* Signal colours for frame def hex editor */
  --signal-colour-0: #22d3ee; /* cyan */
  --signal-colour-1: #4ade80; /* green */
  --signal-colour-2: #facc15; /* yellow */
  --signal-colour-3: #c084fc; /* magenta */
  --signal-colour-4: #60a5fa; /* blue */
  --signal-colour-5: #f87171; /* red */
  --signal-colour-6: #67e8f9; /* light cyan */
  --signal-colour-7: #86efac; /* light green */
```

Also add the same block inside the `:root { }` section (after the existing `--signal-*` block around line 368). Use the same values — these are vibrant enough for both themes and will primarily appear in the dark-themed editor context.

- [ ] **Step 2: Verify CSS compiles**

Run: `cd WireTAP && npx tsc --noEmit`

---

### Task 2: Bit grid utility functions

**Files:**
- Create: `src/apps/rules/utils/bitGrid.ts`

This file contains all pure logic — no React, no DOM. These functions are the core of the editor.

- [ ] **Step 1: Create the utility module with types and constants**

```typescript
// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

export const BYTE_ORDER_LE = 0;
export const BYTE_ORDER_BE = 1;

export const VALUE_TYPE_UNSIGNED = 0;
export const VALUE_TYPE_SIGNED = 1;
export const VALUE_TYPE_FLOAT = 2;
export const VALUE_TYPE_BOOL = 3;
export const VALUE_TYPE_ARRAY = 4;

export const VALUE_TYPES = [
  { value: VALUE_TYPE_UNSIGNED, label: "Unsigned" },
  { value: VALUE_TYPE_SIGNED, label: "Signed" },
  { value: VALUE_TYPE_FLOAT, label: "Float" },
  { value: VALUE_TYPE_BOOL, label: "Bool" },
  { value: VALUE_TYPE_ARRAY, label: "Array" },
];

export const SIGNAL_COLOURS = [
  "var(--signal-colour-0)",
  "var(--signal-colour-1)",
  "var(--signal-colour-2)",
  "var(--signal-colour-3)",
  "var(--signal-colour-4)",
  "var(--signal-colour-5)",
  "var(--signal-colour-6)",
  "var(--signal-colour-7)",
];

export interface PlacedSignal {
  signalId: number;
  name: string;
  startBit: number;
  bitLength: number;
  byteOrder: number;
  valueType: number;
  scale: number;
  offset: number;
  colour: string;
}

export type FrameHeader =
  | { type: "can"; canId: number; dlc: number; extended: boolean }
  | { type: "serial"; framingMode: number };
```

- [ ] **Step 2: Add Motorola bit position function**

Port from `framelink-rs/src/protocol/frame_def.rs:226-239`:

```typescript
export function motorolaBitPositions(startBit: number, bitLength: number): number[] {
  const positions: number[] = [];
  let bit = startBit;
  for (let i = 0; i < bitLength; i++) {
    positions.push(bit);
    const bitInByte = bit % 8;
    if (bitInByte === 0) {
      bit += 15;
    } else {
      bit -= 1;
    }
  }
  return positions;
}

export function signalBitPositions(startBit: number, bitLength: number, byteOrder: number): number[] {
  if (byteOrder === BYTE_ORDER_BE) {
    return motorolaBitPositions(startBit, bitLength);
  }
  return Array.from({ length: bitLength }, (_, i) => startBit + i);
}
```

- [ ] **Step 3: Add bit ownership map**

```typescript
export function buildBitOwnerMap(
  signals: PlacedSignal[],
  payloadBytes: number,
): (number | null)[] {
  const totalBits = payloadBytes * 8;
  const map: (number | null)[] = new Array(totalBits).fill(null);
  for (let i = 0; i < signals.length; i++) {
    const positions = signalBitPositions(
      signals[i].startBit,
      signals[i].bitLength,
      signals[i].byteOrder,
    );
    for (const pos of positions) {
      if (pos < totalBits) {
        map[pos] = i;
      }
    }
  }
  return map;
}
```

- [ ] **Step 4: Add overlap detection**

```typescript
export function checkOverlap(
  startBit: number,
  bitLength: number,
  byteOrder: number,
  existingSignals: PlacedSignal[],
  payloadBytes: number,
): boolean {
  const ownerMap = buildBitOwnerMap(existingSignals, payloadBytes);
  const positions = signalBitPositions(startBit, bitLength, byteOrder);
  return positions.some((pos) => pos < ownerMap.length && ownerMap[pos] !== null);
}
```

- [ ] **Step 5: Add signal ID assignment and colour helpers**

```typescript
// Signal ID 0 is not used; IDs start at 1 (matching the TUI convention)
export function nextSignalId(signals: PlacedSignal[]): number {
  let id = 1;
  while (signals.some((s) => s.signalId === id)) {
    id++;
  }
  return id;
}

export function nextSignalColour(signals: PlacedSignal[]): string {
  const used = new Set(signals.map((s) => s.colour));
  const unused = SIGNAL_COLOURS.find((c) => !used.has(c));
  return unused ?? SIGNAL_COLOURS[signals.length % SIGNAL_COLOURS.length];
}

export function normaliseRange(a: number, b: number): { startBit: number; bitLength: number } {
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  return { startBit: min, bitLength: max - min + 1 };
}
```

- [ ] **Step 6: Add validation helpers**

```typescript
export type ValidationError = string | null;

export function validateSignalType(bitLength: number, valueType: number): ValidationError {
  switch (valueType) {
    case VALUE_TYPE_BOOL:
      return bitLength !== 1 ? "Bool requires exactly 1 bit" : null;
    case VALUE_TYPE_FLOAT:
      return bitLength !== 32 ? "Float requires exactly 32 bits" : null;
    case VALUE_TYPE_ARRAY:
      return bitLength % 8 !== 0 ? "Array requires a multiple of 8 bits" : null;
    default:
      return bitLength > 64 ? "Maximum 64 bits for integer signals" : null;
  }
}

export function canSave(signals: PlacedSignal[]): boolean {
  if (signals.length === 0) return true;
  return signals.every((s) => s.name.trim().length > 0);
}
```

- [ ] **Step 7: Add serialisation helper**

Converts editor state to the JSON shape expected by `framelinkFrameDefAdd()`:

```typescript
export interface FrameDefPayload {
  frame_def_id: number;
  interface_type: number;
  can_id?: number;
  dlc?: number;
  extended?: boolean;
  framing_mode?: number;
  signals: {
    signal_id: number;
    start_bit: number;
    bit_length: number;
    byte_order: number;
    value_type: number;
    scale: number;
    offset: number;
  }[];
}

export function serialiseFrameDef(
  frameDefId: number,
  interfaceType: number,
  header: FrameHeader,
  signals: PlacedSignal[],
): FrameDefPayload {
  const payload: FrameDefPayload = {
    frame_def_id: frameDefId,
    interface_type: interfaceType,
    signals: signals.map((s) => ({
      signal_id: s.signalId,
      start_bit: s.startBit,
      bit_length: s.bitLength,
      byte_order: s.byteOrder,
      value_type: s.valueType,
      scale: s.scale,
      offset: s.offset,
    })),
  };
  if (header.type === "can") {
    payload.can_id = header.canId;
    payload.dlc = header.dlc;
    payload.extended = header.extended;
  } else {
    payload.framing_mode = header.framingMode;
  }
  return payload;
}
```

- [ ] **Step 8: Verify TypeScript compiles**

Run: `cd WireTAP && npx tsc --noEmit`

---

### Task 3: BitGrid component

**Files:**
- Create: `src/apps/rules/components/BitGrid.tsx`

- [ ] **Step 1: Create the basic grid rendering**

The grid renders byte rows with 8 bit cells, colour-coded by signal ownership. Uses `useMemo` for the ownership map.

Props:
- `payloadBytes: number`
- `signals: PlacedSignal[]`
- `selectionAnchor: number | null`
- `selectedSignalIndex: number | null`
- `onBitClick: (bit: number) => void`
- `onByteClick: (byteOffset: number) => void`
- `scrollToByte: number | null`

Structure:
- Grid container: `overflow-y: auto` with `max-h-[400px]`
- Header: column headers `7 6 5 4 3 2 1 0` + byte offset jump input
- Each byte row: clickable row label (byte offset number) + 8 bit cells
- Bit cell styling determined by ownership map:
  - Unassigned: muted (`bg-white/5`)
  - Owned by signal: signal colour as background at 30% opacity
  - Owned by selected signal: signal colour at full opacity
  - Anchor bit: yellow ring (`ring-2 ring-yellow-400`)

- [ ] **Step 2: Add selection and hover interaction**

- Local state `hoveredBit: number | null` tracked via `onMouseEnter`/`onMouseLeave` on cells
- When anchor is set and hovering, bits between anchor and hoveredBit show yellow background (pending selection)
- If any bit in the pending range overlaps an existing signal (per ownership map), show red background instead of yellow
- Click handler: call `onBitClick(bitIndex)` where `bitIndex = byteOffset * 8 + (7 - columnIndex)` (MSB-first display)
- Byte offset label click: call `onByteClick(byteOffset)`

- [ ] **Step 3: Add scroll-to-byte navigation**

- `useRef` for the grid scroll container
- `useRef` Map or array for byte row elements
- `useEffect` watching `scrollToByte`: when it changes, scroll the corresponding row into view
- Jump-to-byte input in the header: number input that sets the scroll position. Validate range (0 to payloadBytes-1).

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd WireTAP && npx tsc --noEmit`

---

### Task 4: SignalList component

**Files:**
- Create: `src/apps/rules/components/SignalList.tsx`

- [ ] **Step 1: Create the SignalList component**

A compact list of all placed signals. Each entry shows a colour dot, signal name, and bit range info.

Props:
- `signals: PlacedSignal[]`
- `selectedIndex: number | null`
- `onSelect: (index: number) => void`

Each signal row shows:
- Colour dot (12px circle using the signal's CSS colour variable)
- Name (or `"(unnamed)"` if empty, in muted style)
- Bit range: `"bit{start}:{length}"` in monospace
- Byte order: `"LE"` or `"BE"` badge

Selected signal has a highlight background. Clicking a signal calls `onSelect(index)`.

Empty state: centred muted text "No signals defined. Click bits in the grid to add signals."

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd WireTAP && npx tsc --noEmit`

---

### Task 5: SignalProperties component

**Files:**
- Create: `src/apps/rules/components/SignalProperties.tsx`

- [ ] **Step 1: Create the SignalProperties component**

An editable form for the currently selected signal's properties.

Props:
- `signal: PlacedSignal | null`
- `onChange: (field: keyof PlacedSignal, value: string | number) => void`
- `onDelete: () => void`
- `validationError: string | null`

When `signal` is `null`, show instructions text: "Click two bits in the grid to define a signal range, or click a byte label to select a whole byte."

When a signal is selected, show:
- **Name** — text input, auto-focused when signal is newly created (use `autoFocus` or `useRef` + `useEffect`)
- **Start Bit / Length** — read-only display (e.g. "Bit 0, 8 bits")
- **Byte Order** — `<select>`: Little Endian (0), Big Endian (1)
- **Value Type** — `<select>` using `VALUE_TYPES` from `bitGrid.ts`
- **Scale** — number input (step 0.1)
- **Offset** — number input (step 0.1)
- Validation error message (if present, shown in red text below value type dropdown)
- If signal name is empty, show inline hint: "Signal name required" below the name field
- **Delete Signal** button (red, at bottom)

Use `inputSimple`, `labelDefault` from styles. Follow the existing dialog form patterns.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd WireTAP && npx tsc --noEmit`

---

### Task 6: FrameDefEditor — top-level editor view

**Files:**
- Create: `src/apps/rules/views/FrameDefEditor.tsx`

- [ ] **Step 1: Define the editor state types and reducer**

```typescript
import type { SignalDefDescriptor } from "../../../api/framelinkRules";
import {
  type PlacedSignal, type FrameHeader,
  nextSignalId, nextSignalColour, normaliseRange,
  SIGNAL_COLOURS, BYTE_ORDER_LE, VALUE_TYPE_UNSIGNED,
} from "../utils/bitGrid";

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

type EditorAction =
  | { type: "SET_ANCHOR"; bit: number }
  | { type: "CLEAR_ANCHOR" }
  | { type: "ADD_SIGNAL"; startBit: number; bitLength: number }
  | { type: "UPDATE_SIGNAL"; index: number; field: keyof PlacedSignal; value: string | number }
  | { type: "DELETE_SIGNAL"; index: number }
  | { type: "SELECT_SIGNAL"; index: number | null };
```

The reducer handles each action:
- `SET_ANCHOR`: sets `selectionAnchor`, clears `selectedSignalIndex`
- `CLEAR_ANCHOR`: clears `selectionAnchor`
- `ADD_SIGNAL`: creates a new `PlacedSignal` with `nextSignalId()`, `nextSignalColour()`, defaults (name `""`, byteOrder LE, valueType unsigned, scale 1.0, offset 0.0). Sets `selectedSignalIndex` to the new signal's index. Clears anchor. Sets `dirty = true`.
- `UPDATE_SIGNAL`: updates the field on the signal at the given index. Sets `dirty = true`.
- `DELETE_SIGNAL`: removes the signal. If `selectedSignalIndex` was the deleted signal, set to `null`. If it was after the deleted signal, decrement by 1. Sets `dirty = true`.
- `SELECT_SIGNAL`: sets `selectedSignalIndex`, clears anchor.

- [ ] **Step 2: Create the FrameDefEditor component**

Props:
```typescript
interface FrameDefEditorProps {
  frameDefId: number;
  interfaceType: number;
  header: FrameHeader;
  payloadBytes: number;
  existingSignals: SignalDefDescriptor[];
  isNew: boolean;
  onSave: (payload: FrameDefPayload, isNew: boolean) => Promise<void>;
  onCancel: () => void;
}
```

Component structure:
1. **Initialise** `useReducer` with state built from props. Map `existingSignals` to `PlacedSignal[]`: preserve signal IDs, assign colours in order via `SIGNAL_COLOURS[i % SIGNAL_COLOURS.length]`, use `name` field from `SignalDefDescriptor` (enriched by backend).

2. **Header bar**: frame def info (ID, interface type name) + "Back" button (left) + "Save" button (right). Save disabled when `!canSave(signals)` or when any signal has a `validateSignalType` error.

3. **Layout**: flex row — left side (BitGrid + SignalList stacked, `flex-[2]`), right side (SignalProperties, `flex-1`)

4. **`onBitClick` handler**:
   - If bit is owned by a signal → dispatch `SELECT_SIGNAL` with that signal's index
   - If anchor is set and clicked bit equals anchor → dispatch `CLEAR_ANCHOR` (cancel selection)
   - If anchor is null → dispatch `SET_ANCHOR`
   - If anchor is set and clicked bit ≠ anchor → normalise range, check overlap. If clear → dispatch `ADD_SIGNAL`. If overlapping → ignore (grid already shows red highlight).

5. **`onByteClick` handler**: check if any bit in the byte (offset * 8 to offset * 8 + 7) is owned. If yes → select that signal. Otherwise → dispatch `ADD_SIGNAL` with `startBit = byteOffset * 8, bitLength = 8`.

6. **`onSave` handler**: call `serialiseFrameDef()` from `bitGrid.ts` to build the payload, pass to `props.onSave(payload, props.isNew)`.

7. **Keyboard handler** (`useEffect` with `keydown` listener on `document`):
   - Escape: if anchor set → `CLEAR_ANCHOR`. Else if signal selected → `SELECT_SIGNAL(null)`.
   - Delete/Backspace: if signal selected and focus is not in an input → `DELETE_SIGNAL`.

8. **Dirty guard on cancel**: if `dirty`, show `window.confirm("Discard unsaved changes?")` before calling `onCancel`.

9. **Memoised `validationError`**: `useMemo` computing `validateSignalType(signal.bitLength, signal.valueType)` for the currently selected signal.

10. **`scrollToByte` state**: local `useState<number | null>(null)`. Set when clicking a signal in SignalList: `Math.floor(signal.startBit / 8)`.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd WireTAP && npx tsc --noEmit`

---

### Task 7: Modify FrameDefsView for list/editor routing

**Files:**
- Modify: `src/apps/rules/views/FrameDefsView.tsx`

- [ ] **Step 1: Add editor routing state and click handlers**

Add imports:
```typescript
import FrameDefEditor from "./FrameDefEditor";
import type { FrameHeader, FrameDefPayload } from "../utils/bitGrid";
import type { SignalDefDescriptor } from "../../../api/framelinkRules";
```

Add local state:
```typescript
const [editingFrameDef, setEditingFrameDef] = useState<{
  frameDefId: number;
  interfaceType: number;
  header: FrameHeader;
  payloadBytes: number;
  signals: SignalDefDescriptor[];
  isNew: boolean;
} | null>(null);
```

Add click handler for editing existing frame defs (on the card):
```typescript
const handleEditFrameDef = (fd: FrameDefDescriptor) => {
  const isCan = fd.can_id != null;
  const header: FrameHeader = isCan
    ? { type: "can", canId: fd.can_id!, dlc: fd.dlc!, extended: fd.extended ?? false }
    : { type: "serial", framingMode: 0 };
  const payloadBytes = isCan
    ? fd.dlc!
    : Math.max(64, Math.ceil(
        Math.max(...fd.signals.map((s) => s.start_bit + s.bit_length), 0) / 8
      ));
  setEditingFrameDef({
    frameDefId: fd.frame_def_id,
    interfaceType: fd.interface_type,
    header,
    payloadBytes,
    signals: fd.signals,
    isNew: false,
  });
};
```

Make each frame def card clickable (add `onClick={() => handleEditFrameDef(fd)}` and `cursor-pointer` to the card div).

- [ ] **Step 2: Update the dialog submission to open editor**

Change `handleAdd` to receive header info from the dialog and open the editor:

```typescript
const handleAdd = useCallback(
  (headerInfo: {
    frameDefId: number;
    interfaceType: number;
    header: FrameHeader;
    payloadBytes: number;
  }) => {
    setEditingFrameDef({
      ...headerInfo,
      signals: [],
      isNew: true,
    });
    setDialogOpen(false);
  },
  [],
);
```

- [ ] **Step 3: Add save handler and conditional rendering**

Save handler (calls store actions, handles remove+add for edits):
```typescript
const handleSave = useCallback(
  async (payload: FrameDefPayload, isNew: boolean) => {
    if (!isNew) {
      await removeFrameDef(payload.frame_def_id);
    }
    await addFrameDef(payload as Record<string, unknown>);
    setEditingFrameDef(null);
  },
  [addFrameDef, removeFrameDef],
);
```

In the JSX, if `editingFrameDef` is not null, render the editor instead of the card list:
```tsx
if (editingFrameDef) {
  return (
    <FrameDefEditor
      frameDefId={editingFrameDef.frameDefId}
      interfaceType={editingFrameDef.interfaceType}
      header={editingFrameDef.header}
      payloadBytes={editingFrameDef.payloadBytes}
      existingSignals={editingFrameDef.signals}
      isNew={editingFrameDef.isNew}
      onSave={handleSave}
      onCancel={() => setEditingFrameDef(null)}
    />
  );
}
```

Place this before the existing loading/list JSX return.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd WireTAP && npx tsc --noEmit`

---

### Task 8: Modify FrameDefDialog to strip signal fields

**Files:**
- Modify: `src/apps/rules/dialogs/FrameDefDialog.tsx`

- [ ] **Step 1: Remove signal-related code**

Remove:
- `SignalRow` interface (lines 12-20)
- `VALUE_TYPES` constant (lines 30-36)
- `signals` state and `nextSignalId` state (lines 52-53)
- `addSignal`, `removeSignal`, `updateSignal` callbacks (lines 55-82)
- `signals` from the `handleSubmit` payload (line 92)
- The entire signals table JSX (lines 176-299)

Remove unused imports: `Plus`, `Trash2` from lucide-react, `iconMd` from spacing.

- [ ] **Step 2: Fix isCan detection for all serial types**

The existing code uses `interfaceType !== 3` which only treats RS-485 as non-CAN. RS-232 (4) and LIN (5) are also serial types without CAN headers. Fix to:

```typescript
const isCan = interfaceType === 1 || interfaceType === 2; // CAN or CAN FD
```

- [ ] **Step 3: Add payload length field for serial types**

Add state: `const [payloadLength, setPayloadLength] = useState(64);`

Add UI for non-CAN types:
```tsx
{!isCan && (
  <div className="grid grid-cols-2 gap-4 mb-4">
    <div>
      <label className={labelDefault}>Payload Length (bytes)</label>
      <input
        type="number"
        className={inputSimple}
        value={payloadLength}
        min={1}
        max={512}
        onChange={(e) => setPayloadLength(Math.min(512, parseInt(e.target.value) || 64))}
      />
    </div>
  </div>
)}
```

- [ ] **Step 4: Update props and submit handler to return header info**

Change the props interface:
```typescript
import type { FrameHeader } from "../utils/bitGrid";

interface FrameDefDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (headerInfo: {
    frameDefId: number;
    interfaceType: number;
    header: FrameHeader;
    payloadBytes: number;
  }) => void;
  interfaces: { index: number; iface_type: number; name: string }[];
  nextId: number;
}
```

Update `handleSubmit`:
```typescript
const handleSubmit = () => {
  const isCan = interfaceType === 1 || interfaceType === 2;
  const header: FrameHeader = isCan
    ? { type: "can", canId: parseInt(canId, 16) || 0, dlc, extended }
    : { type: "serial", framingMode: 0 };
  onSubmit({
    frameDefId,
    interfaceType,
    header,
    payloadBytes: isCan ? dlc : payloadLength,
  });
  onClose();
};
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd WireTAP && npx tsc --noEmit`

---

### Task 9: Final integration and compile verification

**Files:**
- All modified/created files

- [ ] **Step 1: Run Rust check**

Run: `cd WireTAP/src-tauri && cargo check`
Expected: clean (no Rust changes in this plan)

- [ ] **Step 2: Run TypeScript check**

Run: `cd WireTAP && npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Manual testing checklist**

With a device connected:
1. Frame Defs tab shows enriched card list (from previous work)
2. Clicking a frame def card opens the hex editor
3. Bit grid shows correct byte rows with existing signals colour-coded
4. Clicking an unassigned bit sets yellow anchor
5. Clicking the anchor bit again clears the anchor
6. Clicking a second unassigned bit creates a signal (properties panel populates, name field focused)
7. Entering a name and changing properties works
8. Save button disabled when any signal has empty name
9. Clicking a signal in the grid or list selects it
10. Delete button / Delete key removes the signal
11. Save sends to device and returns to list
12. Back button returns to list (with dirty confirmation if needed)
13. "Add Frame Def" opens dialog → fills header → opens editor with empty grid
14. Byte label click selects entire byte
15. Escape clears anchor / deselects signal
16. For large frames (CAN FD 64 bytes), grid scrolls and jump-to-byte works
17. For serial frame types (RS-485, RS-232, LIN), dialog shows payload length field

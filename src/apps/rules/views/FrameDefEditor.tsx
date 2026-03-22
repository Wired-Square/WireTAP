// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// Top-level editor view for frame definitions. Wires together the BitGrid,
// SignalList, and SignalProperties components with a useReducer-based state
// machine for signal placement and editing.

import { useReducer, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { SignalDefDescriptor } from "../../../api/framelinkRules";
import { textPrimary, textSecondary } from "../../../styles";
import { cardDefault, cardPadding } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import {
  type PlacedSignal,
  type FrameHeader,
  type FrameDefPayload,
  nextSignalId,
  nextSignalColour,
  normaliseRange,
  serialiseFrameDef,
  canSave,
  validateSignalType,
  buildBitOwnerMap,
  checkOverlap,
  getSignalColours,
  BYTE_ORDER_LE,
  VALUE_TYPE_UNSIGNED,
} from "../utils/bitGrid";
import BitGrid from "../components/BitGrid";
import SignalList from "../components/SignalList";
import SignalProperties from "../components/SignalProperties";
import { formatHexId } from "../utils/formatHex";

// ============================================================================
// Interface type name lookup
// ============================================================================

const INTERFACE_TYPE_NAMES: Record<number, string> = {
  1: "CAN",
  2: "CAN FD",
  3: "RS-485",
  4: "RS-232",
  5: "LIN",
};

// ============================================================================
// Reducer types and implementation
// ============================================================================

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

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "SET_ANCHOR":
      return {
        ...state,
        selectionAnchor: action.bit,
        selectedSignalIndex: null,
      };

    case "CLEAR_ANCHOR":
      return { ...state, selectionAnchor: null };

    case "ADD_SIGNAL": {
      const newSignal: PlacedSignal = {
        signalId: nextSignalId(state.signals),
        name: "",
        startBit: action.startBit,
        bitLength: action.bitLength,
        byteOrder: BYTE_ORDER_LE,
        valueType: VALUE_TYPE_UNSIGNED,
        scale: 1.0,
        offset: 0.0,
        colour: nextSignalColour(state.signals),
      };
      const signals = [...state.signals, newSignal];
      return {
        ...state,
        signals,
        selectedSignalIndex: signals.length - 1,
        selectionAnchor: null,
        dirty: true,
      };
    }

    case "UPDATE_SIGNAL": {
      const signals = state.signals.map((s, i) =>
        i === action.index ? { ...s, [action.field]: action.value } : s,
      );
      return { ...state, signals, dirty: true };
    }

    case "DELETE_SIGNAL": {
      const signals = state.signals.filter((_, i) => i !== action.index);
      let selectedSignalIndex = state.selectedSignalIndex;
      if (selectedSignalIndex === action.index) {
        selectedSignalIndex = null;
      } else if (selectedSignalIndex !== null && selectedSignalIndex > action.index) {
        selectedSignalIndex -= 1;
      }
      return { ...state, signals, selectedSignalIndex, dirty: true };
    }

    case "SELECT_SIGNAL":
      return {
        ...state,
        selectedSignalIndex: action.index,
        selectionAnchor: null,
      };
  }
}

// ============================================================================
// Component props
// ============================================================================

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

// ============================================================================
// Component
// ============================================================================

export default function FrameDefEditor({
  frameDefId,
  interfaceType,
  header,
  payloadBytes,
  existingSignals,
  isNew,
  onSave,
  onCancel,
}: FrameDefEditorProps) {
  const [state, dispatch] = useReducer(editorReducer, existingSignals, (signals) => {
    const colours = getSignalColours();
    const mapped: PlacedSignal[] = signals.map((sd, i) => ({
      signalId: sd.signal_id,
      name: sd.name,
      startBit: sd.start_bit,
      bitLength: sd.bit_length,
      byteOrder: sd.byte_order,
      valueType: sd.value_type,
      scale: sd.scale,
      offset: sd.offset,
      colour: colours[i % colours.length],
    }));
    return {
      frameDefId,
      interfaceType,
      header,
      payloadBytes,
      signals: mapped,
      selectionAnchor: null,
      selectedSignalIndex: null,
      dirty: false,
    };
  });

  const [scrollToByte, setScrollToByte] = useState<number | null>(null);

  // Validation error for the currently selected signal
  const validationError = useMemo(() => {
    if (state.selectedSignalIndex === null) return null;
    const signal = state.signals[state.selectedSignalIndex];
    if (!signal) return null;
    return validateSignalType(signal.bitLength, signal.valueType);
  }, [state.selectedSignalIndex, state.signals]);

  // Whether any signal has a validation error (blocks save)
  const hasAnyValidationError = useMemo(
    () => state.signals.some((s) => validateSignalType(s.bitLength, s.valueType) !== null),
    [state.signals],
  );

  // Memoised owner map for bit-click handler
  const ownerMap = useMemo(
    () => buildBitOwnerMap(state.signals, payloadBytes),
    [state.signals, payloadBytes],
  );

  // --- Bit click handler ---
  const onBitClick = useCallback(
    (bit: number) => {
      // If bit is owned by a signal, select it
      const owner = bit < ownerMap.length ? ownerMap[bit] : null;
      if (owner !== null) {
        dispatch({ type: "SELECT_SIGNAL", index: owner });
        return;
      }

      // If anchor is set and clicked bit equals anchor, cancel selection
      if (state.selectionAnchor !== null && bit === state.selectionAnchor) {
        dispatch({ type: "CLEAR_ANCHOR" });
        return;
      }

      // If no anchor, set one
      if (state.selectionAnchor === null) {
        dispatch({ type: "SET_ANCHOR", bit });
        return;
      }

      // Anchor is set and clicked bit differs: try to add signal
      const { startBit, bitLength } = normaliseRange(state.selectionAnchor, bit);
      const overlaps = checkOverlap(startBit, bitLength, BYTE_ORDER_LE, state.signals, payloadBytes);
      if (!overlaps) {
        dispatch({ type: "ADD_SIGNAL", startBit, bitLength });
      }
    },
    [ownerMap, state.selectionAnchor, state.signals, payloadBytes],
  );

  // --- Byte click handler ---
  const onByteClick = useCallback(
    (byteOffset: number) => {
      const baseBit = byteOffset * 8;
      // Check if any bit in this byte is owned
      for (let i = 0; i < 8; i++) {
        const owner = baseBit + i < ownerMap.length ? ownerMap[baseBit + i] : null;
        if (owner !== null) {
          dispatch({ type: "SELECT_SIGNAL", index: owner });
          return;
        }
      }
      // No owner — add an 8-bit signal covering the full byte
      dispatch({ type: "ADD_SIGNAL", startBit: baseBit, bitLength: 8 });
    },
    [ownerMap],
  );

  // --- Signal list selection handler ---
  const onSignalSelect = useCallback((index: number) => {
    dispatch({ type: "SELECT_SIGNAL", index });
    const signal = state.signals[index];
    if (signal) {
      setScrollToByte(Math.floor(signal.startBit / 8));
    }
  }, [state.signals]);

  // --- Signal property change handler ---
  const onSignalChange = useCallback(
    (field: keyof PlacedSignal, value: string | number) => {
      if (state.selectedSignalIndex === null) return;
      dispatch({ type: "UPDATE_SIGNAL", index: state.selectedSignalIndex, field, value });
    },
    [state.selectedSignalIndex],
  );

  // --- Signal delete handler ---
  const onSignalDelete = useCallback(() => {
    if (state.selectedSignalIndex === null) return;
    dispatch({ type: "DELETE_SIGNAL", index: state.selectedSignalIndex });
  }, [state.selectedSignalIndex]);

  // --- Save handler ---
  const handleSave = useCallback(async () => {
    const payload = serialiseFrameDef(frameDefId, interfaceType, header, state.signals);
    await onSave(payload, isNew);
  }, [frameDefId, interfaceType, header, state.signals, onSave, isNew]);

  // --- Cancel with dirty guard ---
  const handleCancel = useCallback(() => {
    if (state.dirty) {
      if (!window.confirm("Discard unsaved changes?")) return;
    }
    onCancel();
  }, [state.dirty, onCancel]);

  // --- Keyboard handler ---
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (state.selectionAnchor !== null) {
          dispatch({ type: "CLEAR_ANCHOR" });
        } else if (state.selectedSignalIndex !== null) {
          dispatch({ type: "SELECT_SIGNAL", index: null });
        }
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (state.selectedSignalIndex === null) return;
        const tag = (document.activeElement as HTMLElement)?.tagName?.toLowerCase();
        if (tag === "input" || tag === "select" || tag === "textarea") return;
        dispatch({ type: "DELETE_SIGNAL", index: state.selectedSignalIndex });
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [state.selectionAnchor, state.selectedSignalIndex]);

  // Reset scrollToByte after it fires
  useEffect(() => {
    if (scrollToByte !== null) {
      const id = requestAnimationFrame(() => setScrollToByte(null));
      return () => cancelAnimationFrame(id);
    }
  }, [scrollToByte]);

  // --- Header info ---
  const interfaceTypeName = INTERFACE_TYPE_NAMES[interfaceType] ?? `Type ${interfaceType}`;
  const headerInfo =
    header.type === "can"
      ? `0x${header.canId.toString(16).toUpperCase()}${header.extended ? " (ext)" : ""} | DLC ${header.dlc}`
      : `Framing ${header.framingMode}`;

  const saveDisabled = !canSave(state.signals) || hasAnyValidationError;

  const selectedSignal =
    state.selectedSignalIndex !== null ? state.signals[state.selectedSignalIndex] ?? null : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className={`${cardDefault} ${cardPadding.md} flex items-center justify-between mb-2`}>
        <div className="flex items-center gap-3">
          <button
            onClick={handleCancel}
            className={`p-1.5 rounded hover:bg-[var(--hover-bg)] transition-colors ${textSecondary}`}
            title="Back to frame definitions"
          >
            <ArrowLeft className={iconMd} />
          </button>
          <div>
            <div className={`text-sm font-medium ${textPrimary}`}>
              Frame Def {formatHexId(frameDefId)}
            </div>
            <div className={`text-xs ${textSecondary}`}>
              {interfaceTypeName} | {headerInfo}
            </div>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saveDisabled}
          className="px-4 py-1.5 text-sm font-medium rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Save
        </button>
      </div>

      {/* Main layout: left (grid + signal list) | right (properties) */}
      <div className="flex flex-1 gap-2 min-h-0">
        {/* Left column */}
        <div className="flex-[2] flex flex-col gap-2 min-h-0">
          <div className={`${cardDefault} ${cardPadding.sm} flex-1 min-h-0 overflow-auto`}>
            <BitGrid
              payloadBytes={payloadBytes}
              signals={state.signals}
              selectionAnchor={state.selectionAnchor}
              selectedSignalIndex={state.selectedSignalIndex}
              onBitClick={onBitClick}
              onByteClick={onByteClick}
              scrollToByte={scrollToByte}
            />
          </div>
          <div className={`${cardDefault} ${cardPadding.sm} max-h-48 overflow-auto`}>
            <SignalList
              signals={state.signals}
              selectedIndex={state.selectedSignalIndex}
              onSelect={onSignalSelect}
            />
          </div>
        </div>

        {/* Right column — signal properties */}
        <div className={`flex-1 ${cardDefault} min-h-0 overflow-auto`}>
          <SignalProperties
            signal={selectedSignal}
            onChange={onSignalChange}
            onDelete={onSignalDelete}
            validationError={validationError}
          />
        </div>
      </div>
    </div>
  );
}

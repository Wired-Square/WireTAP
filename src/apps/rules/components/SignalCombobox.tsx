// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  textPrimary,
  textSecondary,
  textTertiary,
  bgPrimary,
  bgSurface,
  borderDefault,
  hoverBg,
  focusRing,
} from "../../../styles";
import { formatHexId } from "../utils/formatHex";
import type { SelectableSignal } from "../../../api/framelinkRules";

// ============================================================================
// Types
// ============================================================================

interface SignalComboboxProps {
  signals: SelectableSignal[];
  value: number | null;
  onChange: (signalId: number) => void;
  placeholder?: string;
  /** Only show signals with bit_length >= this value (for destination signal filtering) */
  minBitLength?: number;
}

// ============================================================================
// Constants
// ============================================================================

const TIER_LABELS: Record<SelectableSignal["tier"], string> = {
  frame_def: "Frame Definition Signals",
  device: "Device Signals",
  user: "User Signals",
};

const TIER_ORDER: SelectableSignal["tier"][] = ["frame_def", "device", "user"];

const DROPDOWN_Z_INDEX = 9999;

// ============================================================================
// Helpers
// ============================================================================

/** Parse a hex string (with or without 0x prefix) into a number, or null if invalid. */
function parseHexInput(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const hexStr = trimmed.startsWith("0x") || trimmed.startsWith("0X")
    ? trimmed.slice(2)
    : trimmed;

  if (!/^[0-9a-fA-F]+$/.test(hexStr)) return null;
  const value = parseInt(hexStr, 16);
  return Number.isFinite(value) ? value : null;
}

/** Check whether a signal matches the current filter text. */
function matchesFilter(signal: SelectableSignal, filter: string): boolean {
  const lower = filter.toLowerCase();

  // Match against signal name
  if (signal.name.toLowerCase().includes(lower)) return true;

  // Match against hex representation of signal_id (strip 0x prefix from filter)
  const hexFilter = lower.startsWith("0x") ? lower.slice(2) : lower;
  const signalHex = signal.signal_id.toString(16).toLowerCase();
  if (signalHex.includes(hexFilter)) return true;

  return false;
}

/** Group and order signals by tier, then by group within each tier. */
function groupSignals(signals: SelectableSignal[]) {
  const result: { tier: SelectableSignal["tier"]; group: string; signals: SelectableSignal[] }[] = [];

  for (const tier of TIER_ORDER) {
    const tierSignals = signals.filter((s) => s.tier === tier);
    if (tierSignals.length === 0) continue;

    // Collect unique groups preserving first-seen order
    const groupOrder: string[] = [];
    const groupMap = new Map<string, SelectableSignal[]>();

    for (const s of tierSignals) {
      if (!groupMap.has(s.group)) {
        groupOrder.push(s.group);
        groupMap.set(s.group, []);
      }
      groupMap.get(s.group)!.push(s);
    }

    for (const group of groupOrder) {
      result.push({ tier, group, signals: groupMap.get(group)! });
    }
  }

  return result;
}

// ============================================================================
// Component
// ============================================================================

export default function SignalCombobox({
  signals,
  value,
  onChange,
  placeholder = "Select signal...",
  minBitLength,
}: SignalComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Resolve selected signal for display
  const selectedSignal = useMemo(
    () => (value != null ? signals.find((s) => s.signal_id === value) ?? null : null),
    [signals, value],
  );

  // Display text: selected signal name + hex ID when not filtering
  const displayText = useMemo(() => {
    if (isOpen) return filter;
    if (selectedSignal) return `${selectedSignal.name} (${formatHexId(selectedSignal.signal_id)})`;
    return "";
  }, [isOpen, filter, selectedSignal]);

  // Filtered and grouped signals
  const filteredGroups = useMemo(() => {
    let filtered = minBitLength != null
      ? signals.filter((s) => s.bit_length >= minBitLength)
      : signals;
    if (filter) filtered = filtered.filter((s) => matchesFilter(s, filter));
    return groupSignals(filtered);
  }, [signals, filter, minBitLength]);

  // Position the dropdown using fixed positioning to escape overflow
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const updatePosition = useCallback(() => {
    if (!inputRef.current) return;
    const rect = inputRef.current.getBoundingClientRect();
    setDropdownStyle({
      position: "fixed",
      top: rect.bottom + 2,
      left: rect.left,
      width: rect.width,
      zIndex: DROPDOWN_Z_INDEX,
    });
  }, []);

  // Open dropdown
  const open = useCallback(() => {
    setIsOpen(true);
    setFilter("");
    updatePosition();
  }, [updatePosition]);

  // Close dropdown
  const close = useCallback(() => {
    setIsOpen(false);
    setFilter("");
  }, []);

  // Select a signal
  const selectSignal = useCallback(
    (signalId: number) => {
      onChange(signalId);
      close();
    },
    [onChange, close],
  );

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    function handleMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        close();
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen, close]);

  // Handle keyboard
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        close();
        inputRef.current?.blur();
        return;
      }

      if (e.key === "Enter" && filter) {
        // Manual hex entry: parse typed text as a hex number
        const parsed = parseHexInput(filter);
        if (parsed != null) {
          selectSignal(parsed);
        }
      }
    },
    [filter, close, selectSignal],
  );

  // Track which tier header has been rendered so sticky headers don't repeat
  const renderedTiers = new Set<SelectableSignal["tier"]>();

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        className={`w-full text-xs py-1 px-2 border rounded ${bgPrimary} ${textPrimary} ${borderDefault} ${focusRing} transition-colors`}
        placeholder={placeholder}
        value={displayText}
        onFocus={open}
        onClick={() => { if (!isOpen) open(); }}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={handleKeyDown}
      />

      {isOpen && (
        <div
          ref={dropdownRef}
          className={`max-h-64 overflow-y-auto border rounded shadow-lg ${bgSurface} ${borderDefault}`}
          style={dropdownStyle}
        >
          {filteredGroups.length === 0 && (
            <div className={`px-2 py-2 text-xs ${textTertiary}`}>
              {filter ? "No matching signals" : "No signals available"}
            </div>
          )}

          {filteredGroups.map(({ tier, group, signals: groupSignals }) => {
            // Render tier header once per tier
            const showTierHeader = !renderedTiers.has(tier);
            if (showTierHeader) renderedTiers.add(tier);

            const tierLabel = TIER_LABELS[tier];

            return (
              <div key={`${tier}:${group}`}>
                {showTierHeader && (
                  <div
                    className={`sticky top-0 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${bgSurface} ${textTertiary} border-b ${borderDefault}`}
                  >
                    {tierLabel}
                  </div>
                )}

                {groupSignals.map((signal) => (
                  <button
                    key={signal.signal_id}
                    type="button"
                    className={`w-full grid grid-cols-[1fr_auto_3rem_auto] gap-x-2 items-center px-2 py-1 text-left text-xs cursor-pointer ${hoverBg}`}
                    onMouseDown={(e) => {
                      // Prevent input blur before we can handle the click
                      e.preventDefault();
                      selectSignal(signal.signal_id);
                    }}
                  >
                    <span className={`truncate ${textPrimary}`}>
                      {signal.name}
                    </span>
                    <span className={`text-right px-2 ${textSecondary}`}>
                      {group}
                    </span>
                    <span className={`text-right font-mono tabular-nums ${textTertiary}`}>
                      {signal.bit_length}b
                    </span>
                    <span className={`text-right font-mono tabular-nums ${textTertiary}`}>
                      {formatHexId(signal.signal_id)}
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Copyright 2026 Wired Square Pty Ltd

import { useState, useRef, useMemo, useCallback } from "react";
import {
  textPrimary,
  textSecondary,
  bgSurface,
  borderDefault,
} from "../../../styles";
import { formatHexId } from "../utils/formatHex";
import type { SelectableSignal } from "../../../api/framelinkRules";
import { Input } from "../../../components/forms";
import { MenuItem, Popover } from "../../../components/Menu";
import { moveFocusAlong } from "../../../components/behaviour/focus";

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

const LIST_KEYS = { ArrowDown: 1, ArrowUp: -1, Home: "first", End: "last" } as const;
const OPTIONS = '[role="option"]';

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
  const listRef = useRef<HTMLDivElement>(null);

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

  const open = useCallback(() => {
    setIsOpen(true);
    setFilter("");
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setFilter("");
  }, []);

  const selectSignal = useCallback(
    (signalId: number) => {
      onChange(signalId);
      close();
    },
    [onChange, close],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        close();
        inputRef.current?.blur();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        listRef.current?.querySelector<HTMLElement>(OPTIONS)?.focus();
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
    <>
      <Input
        ref={inputRef}
        type="text"
        size="sm"
        placeholder={placeholder}
        value={displayText}
        onFocus={open}
        onClick={() => { if (!isOpen) open(); }}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
      />

      <Popover
        ref={listRef}
        open={isOpen}
        onClose={close}
        anchorRef={inputRef}
        matchWidth
        role="listbox"
        className="max-h-64 overflow-y-auto"
        onKeyDown={(e) => {
          if (e.key === "Tab") close();
          moveFocusAlong(e, LIST_KEYS, OPTIONS);
        }}
      >
        {filteredGroups.length === 0 && (
          <div className={`px-2 py-2 text-xs ${textSecondary}`}>
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
                  className={`sticky top-0 px-2 py-1 text-2xs font-semibold uppercase tracking-wider ${bgSurface} ${textSecondary} border-b ${borderDefault}`}
                >
                  {tierLabel}
                </div>
              )}

              {groupSignals.map((signal) => (
                <MenuItem
                  key={signal.signal_id}
                  role="option"
                  aria-selected={signal.signal_id === value}
                  className="grid grid-cols-[1fr_auto_3rem_auto] gap-x-2 px-2 text-xs"
                  onClick={() => selectSignal(signal.signal_id)}
                >
                  <span className={`truncate ${textPrimary}`}>
                    {signal.name}
                  </span>
                  <span className={`text-right px-2 ${textSecondary}`}>
                    {group}
                  </span>
                  <span className={`text-right font-mono tabular-nums ${textSecondary}`}>
                    {signal.bit_length}b
                  </span>
                  <span className={`text-right font-mono tabular-nums ${textSecondary}`}>
                    {formatHexId(signal.signal_id)}
                  </span>
                </MenuItem>
              ))}
            </div>
          );
        })}
      </Popover>
    </>
  );
}

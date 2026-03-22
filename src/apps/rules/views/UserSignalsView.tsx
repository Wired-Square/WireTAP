// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Trash2, Plus } from "lucide-react";
import { useRulesStore } from "../stores/rulesStore";
import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { cardDefault, cardPadding } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import { formatHexId } from "../utils/formatHex";
import UserSignalDialog from "../dialogs/UserSignalDialog";
import type { UserSignalMetadata } from "../dialogs/UserSignalDialog";

export default function UserSignalsView() {
  const { selectableSignals, frameDefs, temporaryRules, addUserSignal, removeUserSignal } =
    useRulesStore(
      useShallow((s) => ({
        selectableSignals: s.selectableSignals,
        frameDefs: s.frameDefs,
        temporaryRules: s.temporaryRules,
        addUserSignal: s.addUserSignal,
        removeUserSignal: s.removeUserSignal,
      })),
    );

  const [dialogOpen, setDialogOpen] = useState(false);

  // Filter to user-tier signals from the selectable signals list
  const userSignals = selectableSignals
    .filter((s) => s.tier === "user")
    .sort((a, b) => a.signal_id - b.signal_id);

  // Build set of all used signal IDs for collision prevention.
  // Combines selectable signals (when loaded) with frame def signals from the
  // board definition (available earlier) as the initial collision source.
  const usedSignalIds = useMemo(() => {
    const ids = new Set(selectableSignals.map((s) => s.signal_id));
    for (const fd of frameDefs) {
      for (const sig of fd.signals) {
        ids.add(sig.signal_id);
      }
    }
    return ids;
  }, [selectableSignals, frameDefs]);

  const handleAdd = useCallback(
    async (signalId: number, metadata: UserSignalMetadata) => {
      try {
        await addUserSignal(signalId, metadata);
        setDialogOpen(false);
      } catch {
        // Error handled by store
      }
    },
    [addUserSignal],
  );

  return (
    <div className="space-y-2">
      {/* Add signal button */}
      <div className="flex items-center mb-2">
        <button
          onClick={() => setDialogOpen(true)}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          <Plus className={iconMd} /> Add User Signal
        </button>
      </div>

      {userSignals.length === 0 && (
        <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
          <p className="text-sm">No user signals added</p>
        </div>
      )}

      {userSignals.map((signal) => {
        const isTemporary = temporaryRules.has(`usersig:${signal.signal_id}`);
        return (
          <div
            key={signal.signal_id}
            className={`${cardDefault} ${cardPadding.md} flex items-center justify-between`}
          >
            <div className="flex items-center gap-2">
              <span className={`text-sm font-mono font-medium ${textPrimary}`}>
                {formatHexId(signal.signal_id)}
              </span>
              <span className={`text-sm ${textPrimary}`}>{signal.name}</span>
              <span className={`text-xs ${textSecondary}`}>
                {signal.group}
              </span>
              {isTemporary && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
                  Temporary
                </span>
              )}
            </div>
            <button
              onClick={() => removeUserSignal(signal.signal_id)}
              className={`p-1 rounded hover:bg-red-500/20 ${textTertiary} hover:text-red-400`}
              title="Remove user signal"
            >
              <Trash2 className={iconMd} />
            </button>
          </div>
        );
      })}

      <UserSignalDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onAdd={handleAdd}
        usedSignalIds={usedSignalIds}
      />
    </div>
  );
}

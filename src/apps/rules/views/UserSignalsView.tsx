// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { Trash2, Plus } from "lucide-react";
import { useRulesStore } from "../stores/rulesStore";
import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { cardDefault, cardPadding } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import { inputSimple } from "../../../styles/inputStyles";

export default function UserSignalsView() {
  const { temporaryRules, addUserSignal, removeUserSignal } = useRulesStore(
    useShallow((s) => ({
      temporaryRules: s.temporaryRules,
      addUserSignal: s.addUserSignal,
      removeUserSignal: s.removeUserSignal,
    })),
  );

  const [newSignalId, setNewSignalId] = useState("");

  // Derive user signals from temporaryRules (those with "usersig:" prefix)
  const userSignalIds = Array.from(temporaryRules)
    .filter((k) => k.startsWith("usersig:"))
    .map((k) => parseInt(k.split(":")[1], 10))
    .sort((a, b) => a - b);

  const handleAdd = useCallback(async () => {
    const id = parseInt(newSignalId, 16);
    if (isNaN(id) || id < 0 || id > 0xffff) return;
    try {
      await addUserSignal(id);
      setNewSignalId("");
    } catch {
      // Error handled by store
    }
  }, [newSignalId, addUserSignal]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleAdd();
    },
    [handleAdd],
  );

  return (
    <div className="space-y-2">
      {/* Add signal input */}
      <div className="flex items-center gap-2 mb-2">
        <input
          type="text"
          className={`${inputSimple} font-mono w-32`}
          value={newSignalId}
          onChange={(e) => setNewSignalId(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Signal ID (hex)"
        />
        <button
          onClick={handleAdd}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-indigo-600 hover:bg-indigo-500 text-white"
          disabled={!newSignalId}
        >
          <Plus className={iconMd} /> Add User Signal
        </button>
      </div>

      {userSignalIds.length === 0 && (
        <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
          <p className="text-sm">No user signals added</p>
        </div>
      )}

      {userSignalIds.map((signalId) => (
        <div
          key={signalId}
          className={`${cardDefault} ${cardPadding.md} flex items-center justify-between`}
        >
          <div className="flex items-center gap-2">
            <span className={`text-sm font-mono font-medium ${textPrimary}`}>
              0x{signalId.toString(16).toUpperCase().padStart(4, "0")}
            </span>
            <span className={`text-xs ${textSecondary}`}>
              Signal ID: {signalId}
            </span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
              Temporary
            </span>
          </div>
          <button
            onClick={() => removeUserSignal(signalId)}
            className={`p-1 rounded hover:bg-red-500/20 ${textTertiary} hover:text-red-400`}
            title="Remove user signal"
          >
            <Trash2 className={iconMd} />
          </button>
        </div>
      ))}
    </div>
  );
}

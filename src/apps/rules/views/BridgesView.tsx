// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { Loader2, Trash2, ToggleLeft, ToggleRight, Plus } from "lucide-react";
import { useRulesStore } from "../stores/rulesStore";
import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { cardDefault, cardPadding } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import type { BridgeDescriptor } from "../../../api/framelinkRules";
import BridgeDialog from "../dialogs/BridgeDialog";

export default function BridgesView() {
  const { bridges, loading, temporaryRules, device, removeBridge, enableBridge, addBridge } =
    useRulesStore(
      useShallow((s) => ({
        bridges: s.bridges,
        loading: s.loading.bridges,
        temporaryRules: s.temporaryRules,
        device: s.device,
        removeBridge: s.removeBridge,
        enableBridge: s.enableBridge,
        addBridge: s.addBridge,
      })),
    );

  const [dialogOpen, setDialogOpen] = useState(false);

  const nextId =
    bridges.length > 0
      ? Math.max(...bridges.map((b) => b.bridge_id)) + 1
      : 1;

  const handleAdd = useCallback(
    async (bridgeDefs: Record<string, unknown>[]) => {
      try {
        for (const b of bridgeDefs) {
          await addBridge(b);
        }
      } catch {
        // Error handled by store
      }
    },
    [addBridge],
  );

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="ml-2 text-sm">Loading bridges...</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end mb-1">
        <button
          onClick={() => setDialogOpen(true)}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          <Plus className={iconMd} /> Add Bridge
        </button>
      </div>

      {bridges.length === 0 && (
        <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
          <p className="text-sm">No bridges on device</p>
        </div>
      )}

      {bridges.map((b: BridgeDescriptor) => {
        const key = `bridge:${b.bridge_id}`;
        const isTemp = temporaryRules.has(key);
        return (
          <div
            key={b.bridge_id}
            className={`${cardDefault} ${cardPadding.md} flex items-start justify-between`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-sm font-mono font-medium ${textPrimary}`}>
                  #{b.bridge_id}
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${isTemp ? "bg-amber-500/20 text-amber-300" : "bg-green-500/20 text-green-300"}`}
                >
                  {isTemp ? "Temporary" : "Existing"}
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${b.enabled ? "bg-blue-500/20 text-blue-300" : "bg-neutral-500/20 text-neutral-400"}`}
                >
                  {b.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <div className={`mt-1 text-xs ${textSecondary}`}>
                {b.source_interface_name} → {b.dest_interface_name}
                {` | ${b.interface_type_name}`}
                {b.filters.length > 0 &&
                  ` | ${b.filters.length} filter${b.filters.length !== 1 ? "s" : ""}`}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => enableBridge(b.bridge_id, !b.enabled)}
                className={`p-1 rounded hover:bg-white/10 ${textSecondary}`}
                title={b.enabled ? "Disable" : "Enable"}
              >
                {b.enabled ? (
                  <ToggleRight className={`${iconMd} text-blue-400`} />
                ) : (
                  <ToggleLeft className={iconMd} />
                )}
              </button>
              <button
                onClick={() => removeBridge(b.bridge_id)}
                className={`p-1 rounded hover:bg-red-500/20 ${textTertiary} hover:text-red-400`}
                title="Remove bridge"
              >
                <Trash2 className={iconMd} />
              </button>
            </div>
          </div>
        );
      })}

      <BridgeDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleAdd}
        interfaces={device?.interfaces ?? []}
        nextId={nextId}
      />
    </div>
  );
}

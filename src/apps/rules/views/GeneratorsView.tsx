// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { Loader2, Trash2, ToggleLeft, ToggleRight, Plus } from "lucide-react";
import { useRulesStore } from "../stores/rulesStore";
import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { cardDefault, cardPadding } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import type { GeneratorDescriptor } from "../../../api/framelinkRules";
import GeneratorDialog from "../dialogs/GeneratorDialog";

export default function GeneratorsView() {
  const {
    generators,
    frameDefs,
    loading,
    temporaryRules,
    device,
    removeGenerator,
    enableGenerator,
    addGenerator,
  } = useRulesStore(
    useShallow((s) => ({
      generators: s.generators,
      frameDefs: s.frameDefs,
      loading: s.loading.generators,
      temporaryRules: s.temporaryRules,
      device: s.device,
      removeGenerator: s.removeGenerator,
      enableGenerator: s.enableGenerator,
      addGenerator: s.addGenerator,
    })),
  );

  const [dialogOpen, setDialogOpen] = useState(false);

  const nextId =
    generators.length > 0
      ? Math.max(...generators.map((g) => g.generator_id)) + 1
      : 1;

  const handleAdd = useCallback(
    async (generator: Record<string, unknown>) => {
      try {
        await addGenerator(generator);
      } catch {
        // Error handled by store
      }
    },
    [addGenerator],
  );

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="ml-2 text-sm">Loading generators...</span>
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
          <Plus className={iconMd} /> Add Generator
        </button>
      </div>

      {generators.length === 0 && (
        <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
          <p className="text-sm">No generators on device</p>
        </div>
      )}

      {generators.map((g: GeneratorDescriptor) => {
        const key = `gen:${g.generator_id}`;
        const isTemp = temporaryRules.has(key);
        return (
          <div
            key={g.generator_id}
            className={`${cardDefault} ${cardPadding.md} flex items-start justify-between`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-sm font-mono font-medium ${textPrimary}`}>
                  #{g.generator_id}
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${isTemp ? "bg-amber-500/20 text-amber-300" : "bg-green-500/20 text-green-300"}`}
                >
                  {isTemp ? "Temporary" : "Existing"}
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${g.enabled ? "bg-blue-500/20 text-blue-300" : "bg-neutral-500/20 text-neutral-400"}`}
                >
                  {g.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <div className={`mt-1 text-xs ${textSecondary}`}>
                {g.frame_def_name} → {g.interface_name}
                {` | ${g.period_ms}ms ${g.trigger_type_name}`}
                {` | ${g.mappings.length} mapping${g.mappings.length !== 1 ? "s" : ""}`}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => enableGenerator(g.generator_id, !g.enabled)}
                className={`p-1 rounded hover:bg-white/10 ${textSecondary}`}
                title={g.enabled ? "Disable" : "Enable"}
              >
                {g.enabled ? (
                  <ToggleRight className={`${iconMd} text-blue-400`} />
                ) : (
                  <ToggleLeft className={iconMd} />
                )}
              </button>
              <button
                onClick={() => removeGenerator(g.generator_id)}
                className={`p-1 rounded hover:bg-red-500/20 ${textTertiary} hover:text-red-400`}
                title="Remove generator"
              >
                <Trash2 className={iconMd} />
              </button>
            </div>
          </div>
        );
      })}

      <GeneratorDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleAdd}
        interfaces={device?.interfaces ?? []}
        frameDefs={frameDefs}
        nextId={nextId}
      />
    </div>
  );
}

// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Loader2, Trash2, ToggleLeft, ToggleRight, Plus } from "lucide-react";
import { useRulesStore } from "../stores/rulesStore";
import { textSecondary, textTertiary } from "../../../styles";
import { cardDefault, cardPadding } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import type { TransformerDescriptor } from "../../../api/framelinkRules";
import { InlineEdit } from "../components/InlineEdit";
import TransformerDialog from "../dialogs/TransformerDialog";
import { formatHexId } from "../utils/formatHex";

export default function TransformersView() {
  const {
    transformers,
    frameDefs,
    loading,
    temporaryRules,
    device,
    removeTransformer,
    enableTransformer,
    addTransformer,
    setLabel,
  } = useRulesStore(
    useShallow((s) => ({
      transformers: s.transformers,
      frameDefs: s.frameDefs,
      loading: s.loading.transformers,
      temporaryRules: s.temporaryRules,
      device: s.device,
      removeTransformer: s.removeTransformer,
      enableTransformer: s.enableTransformer,
      addTransformer: s.addTransformer,
      setLabel: s.setLabel,
    })),
  );

  const [dialogOpen, setDialogOpen] = useState(false);

  const usedIds = useMemo(() => new Set(transformers.map((t) => t.transformer_id)), [transformers]);

  const handleAdd = useCallback(
    async (transformer: Record<string, unknown> & { name?: string; description?: string }) => {
      try {
        const { name, description, ...payload } = transformer;
        await addTransformer(payload);
        if (name || description) {
          await setLabel("transformer", payload.transformer_id as number, name || null, description || null);
        }
      } catch {
        // Error handled by store
      }
    },
    [addTransformer, setLabel],
  );

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="ml-2 text-sm">Loading transformers...</span>
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
          <Plus className={iconMd} /> Add Transformer
        </button>
      </div>

      {transformers.length === 0 && (
        <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
          <p className="text-sm">No transformers on device</p>
        </div>
      )}

      {transformers.map((t: TransformerDescriptor) => {
        const key = `xform:${t.transformer_id}`;
        const isTemp = temporaryRules.has(key);
        return (
          <div
            key={t.transformer_id}
            className={`${cardDefault} ${cardPadding.md} flex items-start justify-between`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span onClick={(e) => e.stopPropagation()}>
                  <InlineEdit
                    value={t.name}
                    variant="primary"
                    onCommit={(newName) => setLabel('transformer', t.transformer_id, newName || null, null)}
                  />
                </span>
                <span className={`text-xs font-mono ${textTertiary}`}>
                  {formatHexId(t.transformer_id)}
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${isTemp ? "bg-amber-500/20 text-amber-300" : "bg-green-500/20 text-green-300"}`}
                >
                  {isTemp ? "Temporary" : "Existing"}
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${t.enabled ? "bg-blue-500/20 text-blue-300" : "bg-neutral-500/20 text-neutral-400"}`}
                >
                  {t.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <div className={`mt-1 text-xs ${textSecondary}`}>
                {t.source_frame_def_name} ({t.source_interface_name}) →{" "}
                {t.dest_frame_def_name}
                {t.dest_frame_def_name !== "Device Signals" ? ` (${t.dest_interface_name})` : ""}
                {` | ${t.mappings.length} mapping${t.mappings.length !== 1 ? "s" : ""}`}
              </div>
              <div className="mt-1">
                <InlineEdit
                  value={t.description ?? ""}
                  placeholder="Add description"
                  variant="secondary"
                  onCommit={(newDesc) => setLabel("transformer", t.transformer_id, null, newDesc || null)}
                />
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => enableTransformer(t.transformer_id, !t.enabled)}
                className={`p-1 rounded hover:bg-white/10 ${textSecondary}`}
                title={t.enabled ? "Disable" : "Enable"}
              >
                {t.enabled ? (
                  <ToggleRight className={`${iconMd} text-blue-400`} />
                ) : (
                  <ToggleLeft className={iconMd} />
                )}
              </button>
              <button
                onClick={() => removeTransformer(t.transformer_id)}
                className={`p-1 rounded hover:bg-red-500/20 ${textTertiary} hover:text-red-400`}
                title="Remove transformer"
              >
                <Trash2 className={iconMd} />
              </button>
            </div>
          </div>
        );
      })}

      <TransformerDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleAdd}
        interfaces={device?.interfaces ?? []}
        frameDefs={frameDefs}
        usedIds={usedIds}
      />
    </div>
  );
}

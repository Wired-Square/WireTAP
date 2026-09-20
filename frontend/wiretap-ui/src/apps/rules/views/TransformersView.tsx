// Copyright 2026 Wired Square Pty Ltd

import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Loader2, Trash2, ToggleLeft, ToggleRight, Plus } from "lucide-react";
import { useRulesStore } from "../stores/rulesStore";
import { textSecondary } from "../../../styles";
import { iconMd } from "../../../styles/spacing";
import type { TransformerDescriptor } from "../../../api/framelinkRules";
import { InlineEdit } from "../components/InlineEdit";
import TransformerDialog from "../dialogs/TransformerDialog";
import { formatHexId } from "../utils/formatHex";
import { Button, IconButton } from "../../../components/Button";
import { Badge } from "../../../components/Badge";
import { Card } from "../../../components/Card";

export default function TransformersView() {
  const { t } = useTranslation("rules");
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
      <div className={`flex items-center justify-center py-12 ${textSecondary}`}>
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="ml-2 text-sm">{t("transformers.loading")}</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end mb-1">
        <Button
          onClick={() => setDialogOpen(true)}
          variant="solid"
          tone="primary"
          size="sm"
        >
          <Plus className={iconMd} /> {t("transformers.add")}
        </Button>
      </div>

      {transformers.length === 0 && (
        <div className={`flex items-center justify-center py-12 ${textSecondary}`}>
          <p className="text-sm">{t("transformers.empty")}</p>
        </div>
      )}

      {transformers.map((xf: TransformerDescriptor) => {
        const key = `xform:${xf.transformer_id}`;
        const isTemp = temporaryRules.has(key);
        return (
          <Card
            key={xf.transformer_id}
            padding="lg"
            className="flex items-start justify-between"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span onClick={(e) => e.stopPropagation()}>
                  <InlineEdit
                    value={xf.name}
                    variant="primary"
                    onCommit={(newName) => setLabel('transformer', xf.transformer_id, newName || null, null)}
                  />
                </span>
                <span className={`text-xs font-mono ${textSecondary}`}>
                  {formatHexId(xf.transformer_id)}
                </span>
                <Badge tone={isTemp ? "warning" : "success"}>
                  {isTemp ? t("common.temporary") : t("common.existing")}
                </Badge>
                <Badge tone={xf.enabled ? "primary" : "neutral"}>
                  {xf.enabled ? t("common.enabled") : t("common.disabled")}
                </Badge>
              </div>
              <div className={`mt-1 text-xs ${textSecondary}`}>
                {xf.source_frame_def_name} ({xf.source_interface_name}) →{" "}
                {xf.dest_frame_def_name}
                {xf.dest_frame_def_name !== "Device Signals" ? ` (${xf.dest_interface_name})` : ""}
                {` | ${t("common.mappingsCount", { count: xf.mappings.length })}`}
              </div>
              <div className="mt-1">
                <InlineEdit
                  value={xf.description ?? ""}
                  placeholder={t("common.addDescription")}
                  variant="secondary"
                  onCommit={(newDesc) => setLabel("transformer", xf.transformer_id, null, newDesc || null)}
                />
              </div>
            </div>
            <div className="flex items-center gap-1">
              <IconButton
                onClick={() => enableTransformer(xf.transformer_id, !xf.enabled)}
                size="sm"
                title={xf.enabled ? t("common.disable") : t("common.enable")}
              >
                {xf.enabled ? (
                  <ToggleRight className={`${iconMd} text-accent-primary`} />
                ) : (
                  <ToggleLeft className={iconMd} />
                )}
              </IconButton>
              <IconButton
                onClick={() => removeTransformer(xf.transformer_id)}
                tone="danger"
                size="sm"
                title={t("transformers.remove")}
              >
                <Trash2 className={iconMd} />
              </IconButton>
            </div>
          </Card>
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

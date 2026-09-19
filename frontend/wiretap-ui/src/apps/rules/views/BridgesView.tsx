// Copyright 2026 Wired Square Pty Ltd

import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Loader2, Trash2, ToggleLeft, ToggleRight, Plus } from "lucide-react";
import { useRulesStore } from "../stores/rulesStore";
import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { cardDefault, cardPadding } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import type { BridgeDescriptor } from "../../../api/framelinkRules";
import BridgeDialog from "../dialogs/BridgeDialog";
import { formatHexId } from "../utils/formatHex";
import { Button, IconButton } from "../../../components/Button";
import { Badge } from "../../../components/Badge";

export default function BridgesView() {
  const { t } = useTranslation("rules");
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

  const usedIds = useMemo(() => new Set(bridges.map((b) => b.bridge_id)), [bridges]);

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
        <span className="ml-2 text-sm">{t("bridges.loading")}</span>
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
          <Plus className={iconMd} /> {t("bridges.add")}
        </Button>
      </div>

      {bridges.length === 0 && (
        <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
          <p className="text-sm">{t("bridges.empty")}</p>
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
                  {formatHexId(b.bridge_id)}
                </span>
                <Badge tone={isTemp ? "warning" : "success"}>
                  {isTemp ? t("common.temporary") : t("common.existing")}
                </Badge>
                <Badge tone={b.enabled ? "primary" : "neutral"}>
                  {b.enabled ? t("common.enabled") : t("common.disabled")}
                </Badge>
              </div>
              <div className={`mt-1 text-xs ${textSecondary}`}>
                {b.source_interface_name} → {b.dest_interface_name}
                {` | ${b.interface_type_name}`}
                {b.filters.length > 0 &&
                  ` | ${t("common.filtersCount", { count: b.filters.length })}`}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <IconButton
                onClick={() => enableBridge(b.bridge_id, !b.enabled)}
                size="sm"
                title={b.enabled ? t("common.disable") : t("common.enable")}
              >
                {b.enabled ? (
                  <ToggleRight className={`${iconMd} text-blue-400`} />
                ) : (
                  <ToggleLeft className={iconMd} />
                )}
              </IconButton>
              <IconButton
                onClick={() => removeBridge(b.bridge_id)}
                tone="danger"
                size="sm"
                title={t("bridges.remove")}
              >
                <Trash2 className={iconMd} />
              </IconButton>
            </div>
          </div>
        );
      })}

      <BridgeDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleAdd}
        interfaces={device?.interfaces ?? []}
        usedIds={usedIds}
      />
    </div>
  );
}

// Copyright 2026 Wired Square Pty Ltd

import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Loader2, Trash2, ToggleLeft, ToggleRight, Plus } from "lucide-react";
import { useRulesStore } from "../stores/rulesStore";
import { textSecondary } from "../../../styles";
import { iconMd } from "../../../styles/spacing";
import type { GeneratorDescriptor } from "../../../api/framelinkRules";
import { InlineEdit } from "../components/InlineEdit";
import GeneratorDialog from "../dialogs/GeneratorDialog";
import { formatHexId } from "../utils/formatHex";
import { Button, IconButton } from "../../../components/Button";
import { Badge } from "../../../components/Badge";
import { Card } from "../../../components/Card";

export default function GeneratorsView() {
  const { t } = useTranslation("rules");
  const {
    generators,
    frameDefs,
    loading,
    temporaryRules,
    device,
    removeGenerator,
    enableGenerator,
    addGenerator,
    setLabel,
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
      setLabel: s.setLabel,
    })),
  );

  const [dialogOpen, setDialogOpen] = useState(false);

  const usedIds = useMemo(
    () => new Set(generators.map((g) => g.generator_id)),
    [generators],
  );

  const handleAdd = useCallback(
    async (generator: Record<string, unknown> & { name?: string; description?: string }) => {
      try {
        const { name, description, ...payload } = generator;
        await addGenerator(payload);
        if (name || description) {
          await setLabel("generator", payload.generator_id as number, name || null, description || null);
        }
      } catch {
        // Error handled by store
      }
    },
    [addGenerator, setLabel],
  );

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-12 ${textSecondary}`}>
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="ml-2 text-sm">{t("generators.loading")}</span>
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
          <Plus className={iconMd} /> {t("generators.add")}
        </Button>
      </div>

      {generators.length === 0 && (
        <div className={`flex items-center justify-center py-12 ${textSecondary}`}>
          <p className="text-sm">{t("generators.empty")}</p>
        </div>
      )}

      {generators.map((g: GeneratorDescriptor) => {
        const key = `gen:${g.generator_id}`;
        const isTemp = temporaryRules.has(key);
        return (
          <Card
            key={g.generator_id}
            padding="lg"
            className="flex items-start justify-between"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span onClick={(e) => e.stopPropagation()}>
                  <InlineEdit
                    value={g.name}
                    variant="primary"
                    onCommit={(newName) => setLabel('generator', g.generator_id, newName || null, null)}
                  />
                </span>
                <span className={`text-xs font-mono ${textSecondary}`}>
                  {formatHexId(g.generator_id)}
                </span>
                <Badge tone={isTemp ? "warning" : "success"}>
                  {isTemp ? t("common.temporary") : t("common.existing")}
                </Badge>
                <Badge tone={g.enabled ? "primary" : "neutral"}>
                  {g.enabled ? t("common.enabled") : t("common.disabled")}
                </Badge>
              </div>
              <div className={`mt-1 text-xs ${textSecondary}`}>
                {g.frame_def_name} → {g.interface_name}
                {` | ${t("generators.details", { period: g.period_ms, trigger: g.trigger_type_name })}`}
                {` | ${t("common.mappingsCount", { count: g.mappings.length })}`}
              </div>
              <div className="mt-1">
                <InlineEdit
                  value={g.description ?? ""}
                  placeholder={t("common.addDescription")}
                  variant="secondary"
                  onCommit={(newDesc) => setLabel("generator", g.generator_id, null, newDesc || null)}
                />
              </div>
            </div>
            <div className="flex items-center gap-1">
              <IconButton
                onClick={() => enableGenerator(g.generator_id, !g.enabled)}
                size="sm"
                title={g.enabled ? t("common.disable") : t("common.enable")}
              >
                {g.enabled ? (
                  <ToggleRight className={`${iconMd} text-blue-400`} />
                ) : (
                  <ToggleLeft className={iconMd} />
                )}
              </IconButton>
              <IconButton
                onClick={() => removeGenerator(g.generator_id)}
                tone="danger"
                size="sm"
                title={t("generators.remove")}
              >
                <Trash2 className={iconMd} />
              </IconButton>
            </div>
          </Card>
        );
      })}

      <GeneratorDialog
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

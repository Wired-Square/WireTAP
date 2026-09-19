// Copyright 2026 Wired Square Pty Ltd

import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Trash2, Plus } from "lucide-react";
import { useRulesStore } from "../stores/rulesStore";
import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { iconMd } from "../../../styles/spacing";
import { formatHexId } from "../utils/formatHex";
import UserSignalDialog from "../dialogs/UserSignalDialog";
import type { UserSignalMetadata } from "../dialogs/UserSignalDialog";
import { Button, IconButton } from "../../../components/Button";
import { Badge } from "../../../components/Badge";
import { Card } from "../../../components/Card";

export default function UserSignalsView() {
  const { t } = useTranslation("rules");
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
        <Button
          onClick={() => setDialogOpen(true)}
          variant="solid"
          tone="primary"
          size="sm"
        >
          <Plus className={iconMd} /> {t("userSignals.add")}
        </Button>
      </div>

      {userSignals.length === 0 && (
        <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
          <p className="text-sm">{t("userSignals.empty")}</p>
        </div>
      )}

      {userSignals.map((signal) => {
        const isTemporary = temporaryRules.has(`usersig:${signal.signal_id}`);
        return (
          <Card
            key={signal.signal_id}
            padding="lg"
            className="flex items-center justify-between"
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
                <Badge tone="warning">{t("common.temporary")}</Badge>
              )}
            </div>
            <IconButton
              onClick={() => removeUserSignal(signal.signal_id)}
              tone="danger"
              size="sm"
              title={t("userSignals.remove")}
            >
              <Trash2 className={iconMd} />
            </IconButton>
          </Card>
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

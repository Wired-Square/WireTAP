// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Loader2, Trash2, Plus } from "lucide-react";
import { useRulesStore } from "../stores/rulesStore";
import { textSecondary, textTertiary } from "../../../styles";
import { cardDefault, cardPadding } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import type { FrameDefDescriptor, SignalDefDescriptor } from "../../../api/framelinkRules";
import { InlineEdit } from "../components/InlineEdit";
import FrameDefDialog from "../dialogs/FrameDefDialog";
import FrameDefEditor from "./FrameDefEditor";
import type { FrameHeader, FrameDefPayload } from "../utils/bitGrid";
import { formatHexId } from "../utils/formatHex";

export default function FrameDefsView() {
  const { t } = useTranslation("rules");
  const { frameDefs, loading, temporaryRules, device, removeFrameDef, addFrameDef, setLabel } =
    useRulesStore(
      useShallow((s) => ({
        frameDefs: s.frameDefs,
        loading: s.loading.frameDefs,
        temporaryRules: s.temporaryRules,
        device: s.device,
        removeFrameDef: s.removeFrameDef,
        addFrameDef: s.addFrameDef,
        setLabel: s.setLabel,
      })),
    );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingFrameDef, setEditingFrameDef] = useState<{
    frameDefId: number;
    interfaceType: number;
    header: FrameHeader;
    payloadBytes: number;
    signals: SignalDefDescriptor[];
    isNew: boolean;
    pendingName?: string;
    pendingDescription?: string;
  } | null>(null);

  const usedIds = useMemo(() => new Set(frameDefs.map((fd) => fd.frame_def_id)), [frameDefs]);

  const handleAdd = useCallback(
    (headerInfo: {
      frameDefId: number;
      interfaceType: number;
      header: FrameHeader;
      payloadBytes: number;
      name?: string;
      description?: string;
    }) => {
      setEditingFrameDef({
        ...headerInfo,
        signals: [],
        isNew: true,
        pendingName: headerInfo.name,
        pendingDescription: headerInfo.description,
      });
      setDialogOpen(false);
    },
    [],
  );

  const handleEditFrameDef = (fd: FrameDefDescriptor) => {
    const isCan = fd.can_id != null;
    const header: FrameHeader = isCan
      ? { type: "can", canId: fd.can_id!, dlc: fd.dlc!, extended: fd.extended ?? false }
      : { type: "serial", framingMode: 0 };
    const payloadBytes = isCan
      ? fd.dlc!
      : Math.max(64, Math.ceil(
          Math.max(...fd.signals.map((s) => s.start_bit + s.bit_length), 0) / 8
        ));
    setEditingFrameDef({
      frameDefId: fd.frame_def_id,
      interfaceType: fd.interface_type,
      header,
      payloadBytes,
      signals: fd.signals,
      isNew: false,
    });
  };

  const handleSave = useCallback(
    async (payload: FrameDefPayload, isNew: boolean) => {
      if (!isNew) {
        await removeFrameDef(payload.frame_def_id);
      }
      await addFrameDef(payload as unknown as Record<string, unknown>);
      // Apply pending label from the creation dialog
      const pending = editingFrameDef;
      if (pending && (pending.pendingName || pending.pendingDescription)) {
        await setLabel("frame_def", payload.frame_def_id, pending.pendingName || null, pending.pendingDescription || null);
      }
      setEditingFrameDef(null);
    },
    [addFrameDef, removeFrameDef, editingFrameDef, setLabel],
  );

  if (editingFrameDef) {
    return (
      <FrameDefEditor
        key={editingFrameDef.frameDefId}
        frameDefId={editingFrameDef.frameDefId}
        interfaceType={editingFrameDef.interfaceType}
        header={editingFrameDef.header}
        payloadBytes={editingFrameDef.payloadBytes}
        existingSignals={editingFrameDef.signals}
        isNew={editingFrameDef.isNew}
        onSave={handleSave}
        onCancel={() => setEditingFrameDef(null)}
      />
    );
  }

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="ml-2 text-sm">{t("frameDefs.loading")}</span>
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
          <Plus className={iconMd} /> {t("frameDefs.add")}
        </button>
      </div>

      {frameDefs.length === 0 && (
        <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
          <p className="text-sm">{t("frameDefs.empty")}</p>
        </div>
      )}

      {frameDefs.map((fd: FrameDefDescriptor) => {
        const key = `framedef:${fd.frame_def_id}`;
        const isTemp = temporaryRules.has(key);
        return (
          <div
            key={fd.frame_def_id}
            className={`${cardDefault} ${cardPadding.md} flex items-start justify-between cursor-pointer`}
            onClick={() => handleEditFrameDef(fd)}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
                <span onClick={(e) => e.stopPropagation()}>
                  <InlineEdit
                    value={fd.name}
                    variant="primary"
                    onCommit={(newName) => setLabel("frame_def", fd.frame_def_id, newName || null, null)}
                  />
                </span>
                <span className={`text-xs font-mono ${textTertiary}`}>
                  #{formatHexId(fd.frame_def_id)}
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${isTemp ? "bg-amber-500/20 text-amber-300" : "bg-green-500/20 text-green-300"}`}
                >
                  {isTemp ? t("common.temporary") : t("common.existing")}
                </span>
                <span className={`text-xs ${textSecondary}`}>
                  {fd.interface_type_name}
                </span>
              </div>
              {fd.can_id != null && (
                <div className={`mt-1 text-xs ${textSecondary}`}>
                  {t("frameDefs.canIdLabel", {
                    id: "0x" + fd.can_id.toString(16).toUpperCase().padStart(fd.extended ? 8 : 3, "0"),
                  })}
                  {fd.extended ? t("frameDefs.canIdExt") : ""}
                  {fd.dlc != null ? ` | ${t("frameDefs.dlcLabel", { dlc: fd.dlc })}` : ""}
                  {` | ${t("common.signalsCount", { count: fd.signals.length })}`}
                </div>
              )}
              {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
              <div className="mt-1" onClick={(e) => e.stopPropagation()}>
                <InlineEdit
                  value={fd.description ?? ""}
                  placeholder={t("common.addDescription")}
                  variant="secondary"
                  onCommit={(newDesc) => setLabel("frame_def", fd.frame_def_id, null, newDesc || null)}
                />
              </div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); removeFrameDef(fd.frame_def_id); }}
              className={`p-1 rounded hover:bg-red-500/20 ${textTertiary} hover:text-red-400`}
              title={t("frameDefs.remove")}
            >
              <Trash2 className={iconMd} />
            </button>
          </div>
        );
      })}

      <FrameDefDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleAdd}
        interfaces={device?.interfaces ?? []}
        usedIds={usedIds}
      />
    </div>
  );
}

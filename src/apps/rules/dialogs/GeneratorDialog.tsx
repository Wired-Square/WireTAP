// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, ArrowDown } from "lucide-react";
import Dialog from "../../../components/Dialog";
import { inputSimple, labelDefault } from "../../../styles/inputStyles";
import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { cardDefault, cardPadding, panelFooter } from "../../../styles/cardStyles";
import { iconMd, iconSm } from "../../../styles/spacing";
import type { FrameDefDescriptor } from "../../../api/framelinkRules";
import SignalCombobox from "../components/SignalCombobox";
import { useRulesStore } from "../stores/rulesStore";
import { DEFAULT_SIGNAL_MASK, nextAvailableId } from "../utils/framelinkConstants";
import { formatHexId } from "../utils/formatHex";

interface MappingRow {
  source_signal_id: number;
  dest_signal_id: number;
  transform_type: string;
  scale: number;
  offset: number;
  mask: number;
}

interface GeneratorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (generator: Record<string, unknown> & { name?: string; description?: string }) => void;
  interfaces: { index: number; iface_type: number; name: string }[];
  frameDefs: FrameDefDescriptor[];
  usedIds: Set<number>;
}

const TRIGGER_KEYS = [
  { value: 0, key: "periodic" },
  { value: 1, key: "onChange" },
  { value: 2, key: "oneShot" },
] as const;

export default function GeneratorDialog({
  isOpen,
  onClose,
  onSubmit,
  interfaces,
  frameDefs,
  usedIds,
}: GeneratorDialogProps) {
  const { t } = useTranslation("rules");
  const selectableSignals = useRulesStore((s) => s.selectableSignals);
  const [generatorId, setGeneratorId] = useState(() => nextAvailableId(usedIds));
  const [validationError, setValidationError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (isOpen) {
      setGeneratorId(nextAvailableId(usedIds));
      setName("");
      setDescription("");
    }
  }, [isOpen, usedIds]);
  const [frameDefId, setFrameDefId] = useState(
    frameDefs[0]?.frame_def_id ?? 0,
  );
  const [interfaceIndex, setInterfaceIndex] = useState(
    interfaces[0]?.index ?? 0,
  );
  const [periodMs, setPeriodMs] = useState(100);
  const [triggerType, setTriggerType] = useState(0);
  const [mappings, setMappings] = useState<MappingRow[]>([]);

  const addMapping = useCallback(() => {
    setMappings((prev) => [
      ...prev,
      {
        source_signal_id: 0,
        dest_signal_id: 0,
        transform_type: "direct",
        scale: 1.0,
        offset: 0.0,
        mask: DEFAULT_SIGNAL_MASK,
      },
    ]);
  }, []);

  const removeMapping = useCallback((idx: number) => {
    setMappings((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const updateMapping = useCallback(
    (idx: number, field: keyof MappingRow, value: string | number) => {
      setMappings((prev) =>
        prev.map((m, i) => (i === idx ? { ...m, [field]: value } : m)),
      );
    },
    [],
  );

  const handleSubmit = () => {
    if (usedIds.has(generatorId)) {
      setValidationError(t("generatorDialog.errors.idInUse", { id: formatHexId(generatorId) }));
      return;
    }
    setValidationError(null);
    onSubmit({
      generator_id: generatorId,
      frame_def_id: frameDefId,
      interface_index: interfaceIndex,
      period_ms: periodMs,
      trigger_type: triggerType,
      enabled: true,
      mappings: mappings.map((m) => ({
        source_signal_id: m.source_signal_id,
        dest_signal_id: m.dest_signal_id,
        transform_type: m.transform_type,
        ...(m.transform_type === "scale" ? { scale: m.scale, offset: m.offset } : {}),
        ...(m.transform_type === "mask" ? { mask: m.mask } : {}),
      })),
      name: name || undefined,
      description: description || undefined,
    });
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-2xl">
      <div className="p-6">
        <h2 className={`text-lg font-semibold ${textPrimary} mb-4`}>
          {t("generatorDialog.title")}
        </h2>

        {validationError && (
          <div className="mb-3 p-2 text-xs text-red-400 bg-red-500/10 rounded">{validationError}</div>
        )}

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className={labelDefault}>{t("generatorDialog.fields.name")}</label>
            <input
              className={inputSimple}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("generatorDialog.fields.namePlaceholder")}
            />
          </div>
          <div>
            <label className={labelDefault}>{t("generatorDialog.fields.description")}</label>
            <input
              className={inputSimple}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("generatorDialog.fields.namePlaceholder")}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className={labelDefault}>{t("generatorDialog.fields.generatorId")}</label>
            <input
              type="number"
              className={inputSimple}
              value={generatorId}
              onChange={(e) => setGeneratorId(parseInt(e.target.value) || 0)}
            />
          </div>
          <div>
            <label className={labelDefault}>{t("generatorDialog.fields.frameDef")}</label>
            <select
              className={inputSimple}
              value={frameDefId}
              onChange={(e) => setFrameDefId(parseInt(e.target.value))}
            >
              {frameDefs.map((fd) => (
                <option key={fd.frame_def_id} value={fd.frame_def_id}>
                  {fd.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 mb-4">
          <div>
            <label className={labelDefault}>{t("generatorDialog.fields.outputInterface")}</label>
            <select
              className={inputSimple}
              value={interfaceIndex}
              onChange={(e) => setInterfaceIndex(parseInt(e.target.value))}
            >
              {interfaces.map((iface) => (
                <option key={iface.index} value={iface.index}>
                  {iface.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelDefault}>{t("generatorDialog.fields.periodMs")}</label>
            <input
              type="number"
              className={inputSimple}
              value={periodMs}
              min={1}
              onChange={(e) => setPeriodMs(parseInt(e.target.value) || 100)}
            />
          </div>
          <div>
            <label className={labelDefault}>{t("generatorDialog.fields.trigger")}</label>
            <select
              className={inputSimple}
              value={triggerType}
              onChange={(e) => setTriggerType(parseInt(e.target.value))}
            >
              {TRIGGER_KEYS.map((tt) => (
                <option key={tt.value} value={tt.value}>
                  {t(`generatorDialog.triggers.${tt.key}`)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Signal mappings */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className={labelDefault}>{t("generatorDialog.fields.mappings")}</label>
            <button
              onClick={addMapping}
              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
            >
              <Plus className={iconMd} /> {t("generatorDialog.fields.addMapping")}
            </button>
          </div>
          <div className="space-y-2">
            {mappings.map((m, idx) => {
              const srcSignal = selectableSignals.find((s) => s.signal_id === m.source_signal_id);
              return (
              <div key={idx} className={`${cardDefault} ${cardPadding.sm}`}>
                <div className="flex items-start gap-3">
                  {/* Source → Dest vertical flow */}
                  <div className="flex-1 space-y-1">
                    <label className={`text-xs ${textTertiary}`}>{t("generatorDialog.fields.sourceSignal")}</label>
                    <SignalCombobox
                      signals={selectableSignals}
                      value={m.source_signal_id || null}
                      onChange={(id) => updateMapping(idx, "source_signal_id", id)}
                      placeholder={t("generatorDialog.fields.sourcePlaceholder")}
                    />
                    <div className={`flex justify-center ${textTertiary}`}>
                      <ArrowDown className={iconSm} />
                    </div>
                    <label className={`text-xs ${textTertiary}`}>{t("generatorDialog.fields.destSignal")}</label>
                    <SignalCombobox
                      signals={selectableSignals}
                      value={m.dest_signal_id || null}
                      onChange={(id) => updateMapping(idx, "dest_signal_id", id)}
                      placeholder={t("generatorDialog.fields.destPlaceholder")}
                      minBitLength={srcSignal?.bit_length}
                    />
                  </div>
                  {/* Transform + delete */}
                  <div className="flex flex-col items-end gap-2 pt-5">
                    <select
                      className={inputSimple}
                      value={m.transform_type}
                      onChange={(e) =>
                        updateMapping(idx, "transform_type", e.target.value)
                      }
                    >
                      <option value="direct">{t("generatorDialog.transforms.direct")}</option>
                      <option value="scale">{t("generatorDialog.transforms.scale")}</option>
                      <option value="invert">{t("generatorDialog.transforms.invert")}</option>
                      <option value="mask">{t("generatorDialog.transforms.mask")}</option>
                    </select>
                    <button
                      onClick={() => removeMapping(idx)}
                      className={`p-1 rounded hover:bg-red-500/20 ${textTertiary} hover:text-red-400`}
                      title={t("generatorDialog.fields.removeMapping")}
                    >
                      <Trash2 className={iconSm} />
                    </button>
                  </div>
                </div>
              </div>
              ); })}
          </div>
        </div>
      </div>

      <div className={`${panelFooter} flex justify-end gap-2`}>
        <button
          onClick={onClose}
          className={`px-4 py-2 text-sm rounded ${textSecondary} hover:bg-white/10`}
        >
          {t("generatorDialog.cancel")}
        </button>
        <button
          onClick={handleSubmit}
          className="px-4 py-2 text-sm font-medium rounded bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          {t("generatorDialog.submit")}
        </button>
      </div>
    </Dialog>
  );
}

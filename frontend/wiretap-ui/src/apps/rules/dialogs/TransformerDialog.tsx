// Copyright 2026 Wired Square Pty Ltd

import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, ArrowDown } from "lucide-react";
import Dialog from "../../../components/Dialog";
import { labelDefault } from "../../../styles/typography";
import { textPrimary, textTertiary } from "../../../styles";
import { cardDefault, cardPadding, panelFooter } from "../../../styles/cardStyles";
import { iconMd, iconSm } from "../../../styles/spacing";
import type { FrameDefDescriptor } from "../../../api/framelinkRules";
import SignalCombobox from "../components/SignalCombobox";
import { useRulesStore } from "../stores/rulesStore";
import { FRAME_DEF_ID_DEVICE, DEFAULT_SIGNAL_MASK, nextAvailableId } from "../utils/framelinkConstants";
import { formatHexId } from "../utils/formatHex";
import { Button, IconButton } from "../../../components/Button";
import { SecondaryButton, PrimaryButton, Input, Select } from "../../../components/forms";

interface MappingRow {
  source_signal_id: number;
  dest_signal_id: number;
  transform_type: string;
  scale: number;
  offset: number;
  mask: number;
}

interface TransformerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (transformer: Record<string, unknown> & { name?: string; description?: string }) => void;
  interfaces: { index: number; iface_type: number; name: string }[];
  frameDefs: FrameDefDescriptor[];
  usedIds: Set<number>;
}

export default function TransformerDialog({
  isOpen,
  onClose,
  onSubmit,
  interfaces,
  frameDefs,
  usedIds,
}: TransformerDialogProps) {
  const { t } = useTranslation("rules");
  const selectableSignals = useRulesStore((s) => s.selectableSignals);

  const [transformerId, setTransformerId] = useState(() => nextAvailableId(usedIds));
  const [validationError, setValidationError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (isOpen) {
      setTransformerId(nextAvailableId(usedIds));
      setName("");
      setDescription("");
    }
  }, [isOpen, usedIds]);
  const [sourceFrameDefId, setSourceFrameDefId] = useState(
    frameDefs[0]?.frame_def_id ?? 0,
  );
  const [sourceInterface, setSourceInterface] = useState(
    interfaces[0]?.index ?? 0,
  );
  const [destFrameDefId, setDestFrameDefId] = useState(FRAME_DEF_ID_DEVICE);
  const [destInterface, setDestInterface] = useState(
    interfaces[0]?.index ?? 0,
  );
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
    if (usedIds.has(transformerId)) {
      setValidationError(t("transformerDialog.errors.idInUse", { id: formatHexId(transformerId) }));
      return;
    }
    setValidationError(null);
    onSubmit({
      transformer_id: transformerId,
      source_frame_def_id: sourceFrameDefId,
      source_interface: sourceInterface,
      dest_frame_def_id: destFrameDefId,
      dest_interface: destFrameDefId === FRAME_DEF_ID_DEVICE ? 0xff : destInterface,
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
          {t("transformerDialog.title")}
        </h2>

        {validationError && (
          <div className="mb-3 p-2 text-xs text-red-400 bg-red-500/10 rounded">{validationError}</div>
        )}

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className={labelDefault}>{t("transformerDialog.fields.name")}</label>
            <Input
              size="lg"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("transformerDialog.fields.namePlaceholder")}
            />
          </div>
          <div>
            <label className={labelDefault}>{t("transformerDialog.fields.description")}</label>
            <Input
              size="lg"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("transformerDialog.fields.namePlaceholder")}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className={labelDefault}>{t("transformerDialog.fields.transformerId")}</label>
            <Input
              type="number"
              size="lg"
              value={transformerId}
              onChange={(e) => setTransformerId(parseInt(e.target.value) || 0)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className={labelDefault}>{t("transformerDialog.fields.sourceFrameDef")}</label>
            <Select
              size="lg"
              value={sourceFrameDefId}
              onChange={(e) => setSourceFrameDefId(parseInt(e.target.value))}
            >
              {frameDefs.map((fd) => (
                <option key={fd.frame_def_id} value={fd.frame_def_id}>
                  {fd.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className={labelDefault}>{t("transformerDialog.fields.sourceInterface")}</label>
            <Select
              size="lg"
              value={sourceInterface}
              onChange={(e) => setSourceInterface(parseInt(e.target.value))}
            >
              {interfaces.map((iface) => (
                <option key={iface.index} value={iface.index}>
                  {iface.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className={labelDefault}>{t("transformerDialog.fields.destination")}</label>
            <Select
              size="lg"
              value={destFrameDefId}
              onChange={(e) => setDestFrameDefId(parseInt(e.target.value))}
            >
              <option value={FRAME_DEF_ID_DEVICE}>{t("transformerDialog.fields.deviceSignals")}</option>
              {frameDefs.map((fd) => (
                <option key={fd.frame_def_id} value={fd.frame_def_id}>
                  {fd.name}
                </option>
              ))}
            </Select>
          </div>
          {destFrameDefId !== FRAME_DEF_ID_DEVICE && (
            <div>
              <label className={labelDefault}>{t("transformerDialog.fields.destInterface")}</label>
              <Select
                size="lg"
                value={destInterface}
                onChange={(e) => setDestInterface(parseInt(e.target.value))}
              >
                {interfaces.map((iface) => (
                  <option key={iface.index} value={iface.index}>
                    {iface.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>

        {/* Mappings */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className={labelDefault}>{t("transformerDialog.fields.mappings")}</label>
            <Button
              onClick={addMapping}
              variant="link"
              tone="primary"
              className="text-xs"
            >
              <Plus className={iconMd} /> {t("transformerDialog.fields.addMapping")}
            </Button>
          </div>
          <div className="space-y-2">
            {mappings.map((m, idx) => {
              const srcSignal = selectableSignals.find((s) => s.signal_id === m.source_signal_id);
              return (
              <div key={idx} className={`${cardDefault} ${cardPadding.sm}`}>
                <div className="flex items-start gap-3">
                  {/* Source → Dest vertical flow */}
                  <div className="flex-1 space-y-1">
                    <label className={`text-xs ${textTertiary}`}>{t("transformerDialog.fields.sourceSignal")}</label>
                    <SignalCombobox
                      signals={selectableSignals}
                      value={m.source_signal_id || null}
                      onChange={(id) => updateMapping(idx, "source_signal_id", id)}
                      placeholder={t("transformerDialog.fields.sourcePlaceholder")}
                    />
                    <div className={`flex justify-center ${textTertiary}`}>
                      <ArrowDown className={iconSm} />
                    </div>
                    <label className={`text-xs ${textTertiary}`}>{t("transformerDialog.fields.destSignal")}</label>
                    <SignalCombobox
                      signals={selectableSignals}
                      value={m.dest_signal_id || null}
                      onChange={(id) => updateMapping(idx, "dest_signal_id", id)}
                      placeholder={t("transformerDialog.fields.destPlaceholder")}
                      minBitLength={srcSignal?.bit_length}
                    />
                  </div>
                  {/* Transform + params + delete */}
                  <div className="flex flex-col items-end gap-2 pt-5">
                    <Select
                      size="lg"
                      value={m.transform_type}
                      onChange={(e) =>
                        updateMapping(idx, "transform_type", e.target.value)
                      }
                    >
                      <option value="direct">{t("transformerDialog.transforms.direct")}</option>
                      <option value="scale">{t("transformerDialog.transforms.scale")}</option>
                      <option value="invert">{t("transformerDialog.transforms.invert")}</option>
                      <option value="mask">{t("transformerDialog.transforms.mask")}</option>
                    </Select>
                    {m.transform_type === "scale" && (
                      <div className="flex gap-2">
                        <Input
                          type="number"
                          step="0.1"
                          size="lg"
                          value={m.scale}
                          placeholder={t("transformerDialog.fields.scale")}
                          onChange={(e) =>
                            updateMapping(idx, "scale", parseFloat(e.target.value) || 1)
                          }
                        />
                        <Input
                          type="number"
                          step="0.1"
                          size="lg"
                          value={m.offset}
                          placeholder={t("transformerDialog.fields.offset")}
                          onChange={(e) =>
                            updateMapping(idx, "offset", parseFloat(e.target.value) || 0)
                          }
                        />
                      </div>
                    )}
                    {m.transform_type === "mask" && (
                      <Input
                        type="text"
                        size="lg"
                        mono
                        value={m.mask.toString(16).toUpperCase()}
                        onChange={(e) =>
                          updateMapping(idx, "mask", parseInt(e.target.value, 16) || 0)
                        }
                      />
                    )}
                    <IconButton
                      onClick={() => removeMapping(idx)}
                      tone="danger"
                      size="sm"
                      title={t("transformerDialog.fields.removeMapping")}
                    >
                      <Trash2 className={iconSm} />
                    </IconButton>
                  </div>
                </div>
              </div>
              ); })}
          </div>
        </div>
      </div>

      <div className={`${panelFooter} flex justify-end gap-2`}>
        <SecondaryButton
          onClick={onClose}
        >
          {t("transformerDialog.cancel")}
        </SecondaryButton>
        <PrimaryButton
          onClick={handleSubmit}
        >
          {t("transformerDialog.submit")}
        </PrimaryButton>
      </div>
    </Dialog>
  );
}

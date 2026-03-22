// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useEffect } from "react";
import { Plus, Trash2, ArrowDown } from "lucide-react";
import Dialog from "../../../components/Dialog";
import { inputSimple, labelDefault } from "../../../styles/inputStyles";
import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { cardDefault, cardPadding, panelFooter } from "../../../styles/cardStyles";
import { iconMd, iconSm } from "../../../styles/spacing";
import type { FrameDefDescriptor } from "../../../api/framelinkRules";
import SignalCombobox from "../components/SignalCombobox";
import { useRulesStore } from "../stores/rulesStore";
import { FRAME_DEF_ID_DEVICE, DEFAULT_SIGNAL_MASK, nextAvailableId } from "../utils/framelinkConstants";
import { formatHexId } from "../utils/formatHex";

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
  onSubmit: (transformer: Record<string, unknown>) => void;
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
  const selectableSignals = useRulesStore((s) => s.selectableSignals);

  const [transformerId, setTransformerId] = useState(() => nextAvailableId(usedIds));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) setTransformerId(nextAvailableId(usedIds));
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
      setValidationError(`Transformer ID ${formatHexId(transformerId)} is already in use.`);
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
    });
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-2xl">
      <div className="p-6">
        <h2 className={`text-lg font-semibold ${textPrimary} mb-4`}>
          Add Transformer
        </h2>

        {validationError && (
          <div className="mb-3 p-2 text-xs text-red-400 bg-red-500/10 rounded">{validationError}</div>
        )}

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className={labelDefault}>Transformer ID</label>
            <input
              type="number"
              className={inputSimple}
              value={transformerId}
              onChange={(e) => setTransformerId(parseInt(e.target.value) || 0)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className={labelDefault}>Source Frame Def</label>
            <select
              className={inputSimple}
              value={sourceFrameDefId}
              onChange={(e) => setSourceFrameDefId(parseInt(e.target.value))}
            >
              {frameDefs.map((fd) => (
                <option key={fd.frame_def_id} value={fd.frame_def_id}>
                  {fd.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelDefault}>Source Interface</label>
            <select
              className={inputSimple}
              value={sourceInterface}
              onChange={(e) => setSourceInterface(parseInt(e.target.value))}
            >
              {interfaces.map((iface) => (
                <option key={iface.index} value={iface.index}>
                  {iface.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className={labelDefault}>Destination</label>
            <select
              className={inputSimple}
              value={destFrameDefId}
              onChange={(e) => setDestFrameDefId(parseInt(e.target.value))}
            >
              <option value={FRAME_DEF_ID_DEVICE}>Device Signals</option>
              {frameDefs.map((fd) => (
                <option key={fd.frame_def_id} value={fd.frame_def_id}>
                  {fd.name}
                </option>
              ))}
            </select>
          </div>
          {destFrameDefId !== FRAME_DEF_ID_DEVICE && (
            <div>
              <label className={labelDefault}>Dest Interface</label>
              <select
                className={inputSimple}
                value={destInterface}
                onChange={(e) => setDestInterface(parseInt(e.target.value))}
              >
                {interfaces.map((iface) => (
                  <option key={iface.index} value={iface.index}>
                    {iface.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Mappings */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className={labelDefault}>Signal Mappings</label>
            <button
              onClick={addMapping}
              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
            >
              <Plus className={iconMd} /> Add Mapping
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
                    <label className={`text-xs ${textTertiary}`}>Source Signal</label>
                    <SignalCombobox
                      signals={selectableSignals}
                      value={m.source_signal_id || null}
                      onChange={(id) => updateMapping(idx, "source_signal_id", id)}
                      placeholder="Source signal"
                    />
                    <div className={`flex justify-center ${textTertiary}`}>
                      <ArrowDown className={iconSm} />
                    </div>
                    <label className={`text-xs ${textTertiary}`}>Destination Signal</label>
                    <SignalCombobox
                      signals={selectableSignals}
                      value={m.dest_signal_id || null}
                      onChange={(id) => updateMapping(idx, "dest_signal_id", id)}
                      placeholder="Dest signal"
                      minBitLength={srcSignal?.bit_length}
                    />
                  </div>
                  {/* Transform + params + delete */}
                  <div className="flex flex-col items-end gap-2 pt-5">
                    <select
                      className={inputSimple}
                      value={m.transform_type}
                      onChange={(e) =>
                        updateMapping(idx, "transform_type", e.target.value)
                      }
                    >
                      <option value="direct">Direct</option>
                      <option value="scale">Scale</option>
                      <option value="invert">Invert</option>
                      <option value="mask">Mask</option>
                    </select>
                    {m.transform_type === "scale" && (
                      <div className="flex gap-2">
                        <input
                          type="number"
                          step="0.1"
                          className={inputSimple}
                          value={m.scale}
                          placeholder="Scale"
                          onChange={(e) =>
                            updateMapping(idx, "scale", parseFloat(e.target.value) || 1)
                          }
                        />
                        <input
                          type="number"
                          step="0.1"
                          className={inputSimple}
                          value={m.offset}
                          placeholder="Offset"
                          onChange={(e) =>
                            updateMapping(idx, "offset", parseFloat(e.target.value) || 0)
                          }
                        />
                      </div>
                    )}
                    {m.transform_type === "mask" && (
                      <input
                        type="text"
                        className={`${inputSimple} font-mono`}
                        value={m.mask.toString(16).toUpperCase()}
                        onChange={(e) =>
                          updateMapping(idx, "mask", parseInt(e.target.value, 16) || 0)
                        }
                      />
                    )}
                    <button
                      onClick={() => removeMapping(idx)}
                      className={`p-1 rounded hover:bg-red-500/20 ${textTertiary} hover:text-red-400`}
                      title="Remove mapping"
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
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          className="px-4 py-2 text-sm font-medium rounded bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          Add Transformer
        </button>
      </div>
    </Dialog>
  );
}

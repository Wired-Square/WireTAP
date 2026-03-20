// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";
import Dialog from "../../../components/Dialog";
import { inputSimple, labelDefault } from "../../../styles/inputStyles";
import { textPrimary, textSecondary, textTertiary, borderDefault } from "../../../styles";
import { panelFooter } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import type { FrameDefDescriptor } from "../../../api/framelinkRules";

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
  onSubmit: (generator: Record<string, unknown>) => void;
  interfaces: { index: number; iface_type: number; name: string }[];
  frameDefs: FrameDefDescriptor[];
  nextId: number;
}

const TRIGGER_TYPES = [
  { value: 0, label: "Periodic" },
  { value: 1, label: "On Change" },
  { value: 2, label: "One Shot" },
];

export default function GeneratorDialog({
  isOpen,
  onClose,
  onSubmit,
  interfaces,
  frameDefs,
  nextId,
}: GeneratorDialogProps) {
  const [generatorId, setGeneratorId] = useState(nextId);
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
        mask: 0xffffffff,
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
    });
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-2xl">
      <div className="p-6">
        <h2 className={`text-lg font-semibold ${textPrimary} mb-4`}>
          Add Generator
        </h2>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className={labelDefault}>Generator ID</label>
            <input
              type="number"
              className={inputSimple}
              value={generatorId}
              onChange={(e) => setGeneratorId(parseInt(e.target.value) || 0)}
            />
          </div>
          <div>
            <label className={labelDefault}>Frame Definition</label>
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
            <label className={labelDefault}>Output Interface</label>
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
            <label className={labelDefault}>Period (ms)</label>
            <input
              type="number"
              className={inputSimple}
              value={periodMs}
              min={1}
              onChange={(e) => setPeriodMs(parseInt(e.target.value) || 100)}
            />
          </div>
          <div>
            <label className={labelDefault}>Trigger</label>
            <select
              className={inputSimple}
              value={triggerType}
              onChange={(e) => setTriggerType(parseInt(e.target.value))}
            >
              {TRIGGER_TYPES.map((tt) => (
                <option key={tt.value} value={tt.value}>
                  {tt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Signal mappings */}
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
          {mappings.length > 0 && (
            <div className={`border ${borderDefault} rounded-lg overflow-hidden`}>
              <table className="w-full text-xs">
                <thead>
                  <tr className={`${textTertiary} border-b ${borderDefault}`}>
                    <th className="px-2 py-1 text-left">Src Signal</th>
                    <th className="px-2 py-1 text-left">Dst Signal</th>
                    <th className="px-2 py-1 text-left">Transform</th>
                    <th className="px-2 py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((m, idx) => (
                    <tr key={idx} className={`border-b ${borderDefault} last:border-b-0`}>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          className={`w-16 ${inputSimple} text-xs py-0.5 px-1`}
                          value={m.source_signal_id}
                          onChange={(e) =>
                            updateMapping(idx, "source_signal_id", parseInt(e.target.value) || 0)
                          }
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          className={`w-16 ${inputSimple} text-xs py-0.5 px-1`}
                          value={m.dest_signal_id}
                          onChange={(e) =>
                            updateMapping(idx, "dest_signal_id", parseInt(e.target.value) || 0)
                          }
                        />
                      </td>
                      <td className="px-2 py-1">
                        <select
                          className={`${inputSimple} text-xs py-0.5 px-1`}
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
                      </td>
                      <td className="px-2 py-1">
                        <button
                          onClick={() => removeMapping(idx)}
                          className={`p-0.5 rounded hover:bg-red-500/20 ${textTertiary} hover:text-red-400`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
          Add Generator
        </button>
      </div>
    </Dialog>
  );
}

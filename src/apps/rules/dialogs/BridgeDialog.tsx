// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import Dialog from "../../../components/Dialog";
import { inputSimple, labelDefault } from "../../../styles/inputStyles";
import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { panelFooter } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import { nextAvailableId } from "../utils/framelinkConstants";
import { formatHexId } from "../utils/formatHex";

interface FilterRow {
  can_id: string;
  mask: string;
}

interface BridgeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (bridges: Record<string, unknown>[]) => void;
  interfaces: { index: number; iface_type: number; name: string }[];
  usedIds: Set<number>;
}

export default function BridgeDialog({
  isOpen,
  onClose,
  onSubmit,
  interfaces,
  usedIds,
}: BridgeDialogProps) {
  const { t } = useTranslation("rules");
  const [bridgeId, setBridgeId] = useState(() => nextAvailableId(usedIds));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) setBridgeId(nextAvailableId(usedIds));
  }, [isOpen, usedIds]);
  const [sourceInterface, setSourceInterface] = useState(interfaces[0]?.index ?? 0);
  const [destInterface, setDestInterface] = useState(interfaces[1]?.index ?? interfaces[0]?.index ?? 0);
  const [bidirectional, setBidirectional] = useState(true);
  const [filters, setFilters] = useState<FilterRow[]>([]);

  const interfaceType = interfaces.find(
    (i) => i.index === sourceInterface,
  )?.iface_type ?? 1;

  const addFilter = useCallback(() => {
    setFilters((prev) => [...prev, { can_id: "0", mask: "FFFFFFFF" }]);
  }, []);

  const removeFilter = useCallback((idx: number) => {
    setFilters((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const updateFilter = useCallback(
    (idx: number, field: keyof FilterRow, value: string) => {
      setFilters((prev) =>
        prev.map((f, i) => (i === idx ? { ...f, [field]: value } : f)),
      );
    },
    [],
  );

  const handleSubmit = () => {
    if (usedIds.has(bridgeId)) {
      setValidationError(t("bridgeDialog.errors.idInUse", { id: formatHexId(bridgeId) }));
      return;
    }
    if (bidirectional && usedIds.has(bridgeId + 1)) {
      setValidationError(t("bridgeDialog.errors.reverseInUse", { id: formatHexId(bridgeId + 1) }));
      return;
    }
    setValidationError(null);
    const parsedFilters = filters
      .map((f) => ({
        can_id: parseInt(f.can_id, 16) || 0,
        mask: parseInt(f.mask, 16) || 0xffffffff,
      }));

    const bridges: Record<string, unknown>[] = [
      {
        bridge_id: bridgeId,
        source_interface: sourceInterface,
        dest_interface: destInterface,
        interface_type: interfaceType,
        enabled: true,
        filters: parsedFilters,
      },
    ];

    if (bidirectional) {
      bridges.push({
        bridge_id: bridgeId + 1,
        source_interface: destInterface,
        dest_interface: sourceInterface,
        interface_type: interfaceType,
        enabled: true,
        filters: parsedFilters,
      });
    }

    onSubmit(bridges);
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-lg">
      <div className="p-6">
        <h2 className={`text-lg font-semibold ${textPrimary} mb-4`}>
          {t("bridgeDialog.title")}
        </h2>

        {validationError && (
          <div className="mb-3 p-2 text-xs text-red-400 bg-red-500/10 rounded">{validationError}</div>
        )}

        <div className="space-y-4">
          <div>
            <label className={labelDefault}>{t("bridgeDialog.fields.bridgeId")}</label>
            <input
              type="number"
              className={inputSimple}
              value={bridgeId}
              onChange={(e) => setBridgeId(parseInt(e.target.value) || 0)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelDefault}>{t("bridgeDialog.fields.sourceInterface")}</label>
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
            <div>
              <label className={labelDefault}>{t("bridgeDialog.fields.destInterface")}</label>
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
          </div>

          <label className={`flex items-center gap-2 text-sm ${textSecondary}`}>
            <input
              type="checkbox"
              checked={bidirectional}
              onChange={(e) => setBidirectional(e.target.checked)}
            />
            {t("bridgeDialog.fields.bidirectional")}
          </label>

          {/* Filters */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={labelDefault}>{t("bridgeDialog.fields.filters")}</label>
              <button
                onClick={addFilter}
                className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
              >
                <Plus className={iconMd} /> {t("bridgeDialog.fields.addFilter")}
              </button>
            </div>

            {filters.length > 0 && (
              <div className="space-y-2">
                {filters.map((f, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      className={`${inputSimple} font-mono flex-1`}
                      value={f.can_id}
                      onChange={(e) => updateFilter(idx, "can_id", e.target.value)}
                      placeholder={t("bridgeDialog.fields.canIdHex")}
                    />
                    <input
                      type="text"
                      className={`${inputSimple} font-mono flex-1`}
                      value={f.mask}
                      onChange={(e) => updateFilter(idx, "mask", e.target.value)}
                      placeholder={t("bridgeDialog.fields.maskHex")}
                    />
                    <button
                      onClick={() => removeFilter(idx)}
                      className={`p-1 rounded hover:bg-red-500/20 ${textTertiary} hover:text-red-400`}
                    >
                      <Trash2 className={iconMd} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={`${panelFooter} flex justify-end gap-2`}>
        <button
          onClick={onClose}
          className={`px-4 py-2 text-sm rounded ${textSecondary} hover:bg-white/10`}
        >
          {t("bridgeDialog.cancel")}
        </button>
        <button
          onClick={handleSubmit}
          className="px-4 py-2 text-sm font-medium rounded bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          {bidirectional ? t("bridgeDialog.submitTwo") : t("bridgeDialog.submitOne")}
        </button>
      </div>
    </Dialog>
  );
}

// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, HelpCircle } from "lucide-react";
import Dialog from "../../../components/Dialog";
import { inputSimple, labelDefault } from "../../../styles/inputStyles";
import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { panelFooter } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import { nextAvailableId } from "../utils/framelinkConstants";
import { formatHexId } from "../utils/formatHex";
import { ID_MASK_29, parseHex } from "../utils/canMask";
import BridgeFilterHelp from "./BridgeFilterHelp";
import type {
  BridgeFilterKind,
  BridgeFilterIde,
  BridgeDefaultAction,
} from "../../../api/framelinkRules";

interface FilterRow {
  kind: BridgeFilterKind;
  ide: BridgeFilterIde;
  a: string;
  b: string;
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
  const [defaultAction, setDefaultAction] = useState<BridgeDefaultAction>('pass');
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [openHelp, setOpenHelp] = useState<Set<number>>(new Set());

  const toggleHelp = useCallback((idx: number) => {
    setOpenHelp((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }, []);

  const interfaceType = interfaces.find(
    (i) => i.index === sourceInterface,
  )?.iface_type ?? 1;

  const isDeny = defaultAction === 'pass';
  const filtersLabel = t(isDeny
    ? "bridgeDialog.fields.filtersDeny"
    : "bridgeDialog.fields.filtersAllow");
  const filtersTooltip = t(isDeny
    ? "bridgeDialog.tooltips.filtersDeny"
    : "bridgeDialog.tooltips.filtersAllow");

  const addFilter = useCallback(() => {
    setFilters((prev) => [
      ...prev,
      { kind: 'mask', ide: 'any', a: '0', b: '7FF' },
    ]);
  }, []);

  const removeFilter = useCallback((idx: number) => {
    setFilters((prev) => prev.filter((_, i) => i !== idx));
    setOpenHelp((prev) => {
      const next = new Set<number>();
      prev.forEach((i) => {
        if (i < idx) next.add(i);
        else if (i > idx) next.add(i - 1);
      });
      return next;
    });
  }, []);

  const updateFilter = useCallback(
    <K extends keyof FilterRow>(idx: number, field: K, value: FilterRow[K]) => {
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
    const parsedFilters = filters.map((f) => {
      const a = parseHex(f.a, 0, ID_MASK_29);
      const bDefault = f.kind === 'mask' ? ID_MASK_29 : a;
      const b = parseHex(f.b, bDefault, ID_MASK_29);
      return { kind: f.kind, ide: f.ide, a, b };
    });

    for (const f of parsedFilters) {
      if (f.kind === 'range' && f.a > f.b) {
        setValidationError(
          t("bridgeDialog.errors.rangeLoGtHi", {
            lo: `0x${f.a.toString(16).toUpperCase()}`,
            hi: `0x${f.b.toString(16).toUpperCase()}`,
          }),
        );
        return;
      }
    }

    const bridges: Record<string, unknown>[] = [
      {
        bridge_id: bridgeId,
        source_interface: sourceInterface,
        dest_interface: destInterface,
        interface_type: interfaceType,
        enabled: true,
        default_action: defaultAction,
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
        default_action: defaultAction,
        filters: parsedFilters,
      });
    }

    onSubmit(bridges);
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-xl">
      <div className="p-6">
        <h2 className={`text-lg font-semibold ${textPrimary} mb-4`}>
          {t("bridgeDialog.title")}
        </h2>

        {validationError && (
          <div className="mb-3 p-2 text-xs text-red-400 bg-red-500/10 rounded">{validationError}</div>
        )}

        <div className="space-y-4">
          <div>
            <label
              className={labelDefault}
              title={t("bridgeDialog.tooltips.bridgeId")}
            >
              {t("bridgeDialog.fields.bridgeId")}
            </label>
            <input
              type="number"
              className={inputSimple}
              value={bridgeId}
              onChange={(e) => setBridgeId(parseInt(e.target.value) || 0)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                className={labelDefault}
                title={t("bridgeDialog.tooltips.sourceInterface")}
              >
                {t("bridgeDialog.fields.sourceInterface")}
              </label>
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
              <label
                className={labelDefault}
                title={t("bridgeDialog.tooltips.destInterface")}
              >
                {t("bridgeDialog.fields.destInterface")}
              </label>
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

          <label
            className={`flex items-center gap-2 text-sm ${textSecondary}`}
            title={t("bridgeDialog.tooltips.bidirectional")}
          >
            <input
              type="checkbox"
              checked={bidirectional}
              onChange={(e) => setBidirectional(e.target.checked)}
            />
            {t("bridgeDialog.fields.bidirectional")}
          </label>

          <div>
            <label
              className={labelDefault}
              title={t("bridgeDialog.tooltips.defaultAction")}
            >
              {t("bridgeDialog.fields.defaultAction")}
            </label>
            <select
              className={inputSimple}
              value={defaultAction}
              onChange={(e) => setDefaultAction(e.target.value as BridgeDefaultAction)}
              title={t("bridgeDialog.tooltips.defaultAction")}
            >
              <option value="pass">{t("bridgeDialog.action.pass")}</option>
              <option value="block">{t("bridgeDialog.action.block")}</option>
            </select>
          </div>

          {/* Filters */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={labelDefault} title={filtersTooltip}>
                {filtersLabel}
              </label>
              <button
                onClick={addFilter}
                className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
              >
                <Plus className={iconMd} /> {t("bridgeDialog.fields.addFilter")}
              </button>
            </div>

            {filters.length > 0 && (
              <div className="space-y-3">
                {filters.map((f, idx) => {
                  const isMask = f.kind === 'mask';
                  const aLabel = t(isMask
                    ? "bridgeDialog.fields.canIdLabel"
                    : "bridgeDialog.fields.loLabel");
                  const bLabel = t(isMask
                    ? "bridgeDialog.fields.maskLabel"
                    : "bridgeDialog.fields.hiLabel");
                  const aPlaceholder = t(isMask
                    ? "bridgeDialog.fields.canIdHex"
                    : "bridgeDialog.fields.loHex");
                  const bPlaceholder = t(isMask
                    ? "bridgeDialog.fields.maskHex"
                    : "bridgeDialog.fields.hiHex");
                  const aTooltip = t(isMask
                    ? "bridgeDialog.tooltips.aMask"
                    : "bridgeDialog.tooltips.aRange");
                  const bTooltip = t(isMask
                    ? "bridgeDialog.tooltips.bMask"
                    : "bridgeDialog.tooltips.bRange");
                  const helpOpen = openHelp.has(idx);
                  return (
                    <div
                      key={idx}
                      className="p-3 rounded border border-[color:var(--border-default)] space-y-2"
                    >
                      <div className="flex items-center gap-2">
                        <div className="flex-none w-28">
                          <select
                            className={inputSimple}
                            value={f.kind}
                            onChange={(e) =>
                              updateFilter(idx, 'kind', e.target.value as BridgeFilterKind)
                            }
                            title={t("bridgeDialog.tooltips.kind")}
                          >
                            <option value="mask">{t("bridgeDialog.kind.mask")}</option>
                            <option value="range">{t("bridgeDialog.kind.range")}</option>
                          </select>
                        </div>
                        <div className="flex-none w-24">
                          <select
                            className={inputSimple}
                            value={f.ide}
                            onChange={(e) =>
                              updateFilter(idx, 'ide', e.target.value as BridgeFilterIde)
                            }
                            title={t("bridgeDialog.tooltips.ide")}
                          >
                            <option value="any">{t("bridgeDialog.ide.any")}</option>
                            <option value="std">{t("bridgeDialog.ide.std")}</option>
                            <option value="ext">{t("bridgeDialog.ide.ext")}</option>
                          </select>
                        </div>
                        <div className="flex-1" />
                        <button
                          type="button"
                          onClick={() => toggleHelp(idx)}
                          aria-pressed={helpOpen}
                          aria-label={t(helpOpen
                            ? "bridgeDialog.fields.helpHide"
                            : "bridgeDialog.fields.helpShow")}
                          title={t("bridgeDialog.tooltips.helpToggle")}
                          className={`p-1 rounded hover:bg-white/10 ${
                            helpOpen ? "text-blue-400" : textTertiary
                          } hover:text-blue-300`}
                        >
                          <HelpCircle className={iconMd} />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeFilter(idx)}
                          className={`p-1 rounded hover:bg-red-500/20 ${textTertiary} hover:text-red-400`}
                        >
                          <Trash2 className={iconMd} />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className={`block text-xs ${textSecondary} mb-1`}>
                            {aLabel}
                          </label>
                          <input
                            type="text"
                            className={`${inputSimple} font-mono w-full`}
                            value={f.a}
                            onChange={(e) => updateFilter(idx, 'a', e.target.value)}
                            placeholder={aPlaceholder}
                            title={aTooltip}
                          />
                        </div>
                        <div>
                          <label className={`block text-xs ${textSecondary} mb-1`}>
                            {bLabel}
                          </label>
                          <input
                            type="text"
                            className={`${inputSimple} font-mono w-full`}
                            value={f.b}
                            onChange={(e) => updateFilter(idx, 'b', e.target.value)}
                            placeholder={bPlaceholder}
                            title={bTooltip}
                          />
                        </div>
                      </div>

                      {helpOpen && (
                        <BridgeFilterHelp
                          kind={f.kind}
                          ide={f.ide}
                          onApplyMask={(canIdHex, maskHex) => {
                            updateFilter(idx, 'a', canIdHex);
                            updateFilter(idx, 'b', maskHex);
                          }}
                        />
                      )}
                    </div>
                  );
                })}
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

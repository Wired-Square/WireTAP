// Copyright 2026 Wired Square Pty Ltd
//
// Indicator configuration dialog — mirrors the TUI's indicator edit wizard.
// Three source types: Activity (frame RX toggle), Palette (signal→colour),
// Threshold (signal above/below → colour).

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { labelDefault } from "../../../styles/typography";
import { textTertiary } from "../../../styles";
import ColourPicker from "../components/ColourPicker";
import { cssToBrgb } from "../utils/brgbColour";
import {
  framelinkIndicatorConfigure,
  framelinkIndicatorRemove,
  framelinkDsigWrite,
  framelinkPalettesList,
  type DiscoveredLed,
  type PaletteInfo,
} from "../../../api/framelinkRules";
import SignalCombobox from "../components/SignalCombobox";
import { useRulesStore } from "../stores/rulesStore";
import { Button } from "../../../components/Button";
import { SecondaryButton, PrimaryButton, Input, Select } from "../../../components/forms";
import { Alert } from "../../../components/Alert";
const COLOUR_WRITE_DEBOUNCE_MS = 150;
const DEFAULT_CAN_ID_HEX = "100";
const DEFAULT_DATA_MASK_HEX = "FF00000000000000";

const STATE_KEYS = [
  { value: 0, key: "off" },
  { value: 1, key: "on" },
  { value: 2, key: "blink" },
] as const;

export interface LedUpdateValues {
  colour: number;
  state: number;
  blink_period: number;
}

interface IndicatorConfigDialogProps {
  isOpen: boolean;
  onClose: (updated?: LedUpdateValues) => void;
  onConfigured: () => void;
  deviceId: string;
  led: DiscoveredLed;
  interfaces: { index: number; iface_type: number; name: string }[];
}

type SourceType = "activity" | "palette" | "threshold";

export default function IndicatorConfigDialog({
  isOpen,
  onClose,
  onConfigured,
  deviceId,
  led,
  interfaces,
}: IndicatorConfigDialogProps) {
  const { t } = useTranslation("rules");
  const selectableSignals = useRulesStore((s) => s.selectableSignals);
  const [source, setSource] = useState<SourceType>("activity");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Activity state
  const [activityInterface, setActivityInterface] = useState(
    led.interface_index ?? interfaces[0]?.index ?? 0,
  );
  const [triggerMode, setTriggerMode] = useState<"any" | "id" | "match">("any");
  const [canId, setCanId] = useState(DEFAULT_CAN_ID_HEX);
  const [dataMask, setDataMask] = useState(DEFAULT_DATA_MASK_HEX);
  // Palette state
  const [palettes, setPalettes] = useState<PaletteInfo[]>([]);
  const [selectedPalette, setSelectedPalette] = useState(0);
  const [palSourceSignal, setPalSourceSignal] = useState<number | null>(null);
  const [signalMax, setSignalMax] = useState(1000);
  const [gateSignalId, setGateSignalId] = useState("");

  // Threshold state
  const [thrSourceSignal, setThrSourceSignal] = useState<number | null>(null);
  const [threshold, setThreshold] = useState(500);
  const [valueAbove, setValueAbove] = useState(cssToBrgb(0, 255, 0, 255));
  const [valueBelow, setValueBelow] = useState(0);
  const [thrGateSignalId, setThrGateSignalId] = useState("");

  // LED property state (local, written to device on individual change)
  const [ledState, setLedState] = useState(led.state);
  const [blinkPeriod, setBlinkPeriod] = useState(led.blink_period);
  const [ledColour, setLedColour] = useState(led.colour);
  const activityColour = ledColour || cssToBrgb(0, 255, 0, 255);

  const writeState = useCallback(async (state: number) => {
    setLedState(state);
    try { await framelinkDsigWrite(deviceId, led.state_signal_id, state); } catch (e) { setError(String(e)); }
  }, [deviceId, led.state_signal_id]);

  const writeBlinkPeriod = useCallback(async (period: number) => {
    try { await framelinkDsigWrite(deviceId, led.blink_period_signal_id, period); } catch (e) { setError(String(e)); }
  }, [deviceId, led.blink_period_signal_id]);

  const colourDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const writeColour = useCallback((brgb: number) => {
    setLedColour(brgb);
    clearTimeout(colourDebounceRef.current);
    colourDebounceRef.current = setTimeout(async () => {
      try { await framelinkDsigWrite(deviceId, led.colour_signal_id, brgb); } catch (e) { setError(String(e)); }
    }, COLOUR_WRITE_DEBOUNCE_MS);
  }, [deviceId, led.colour_signal_id]);

  const closeWithValues = useCallback(() => {
    onClose({ colour: ledColour, state: ledState, blink_period: blinkPeriod });
  }, [onClose, ledColour, ledState, blinkPeriod]);

  const handleClear = useCallback(async () => {
    try {
      await framelinkIndicatorRemove(deviceId, led.index, led.colour_signal_id, led.state_signal_id);
      onConfigured();
      onClose();
    } catch (e) { setError(String(e)); }
  }, [deviceId, led, onConfigured, onClose]);

  // Clear pending colour write on unmount
  useEffect(() => {
    return () => clearTimeout(colourDebounceRef.current);
  }, []);

  // Load palettes when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    framelinkPalettesList(deviceId).then(setPalettes).catch(() => {});
  }, [isOpen, deviceId]);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const params: Record<string, unknown> = {
        source,
        led: {
          index: led.index,
          label: led.label,
          colour_signal_id: led.colour_signal_id,
          state_signal_id: led.state_signal_id,
          blink_period_signal_id: led.blink_period_signal_id,
          toggle_signal_id: led.toggle_signal_id,
          interface_index: led.interface_index,
          interface_type: led.interface_type,
          colour: led.colour,
          state: led.state,
          blink_period: led.blink_period,
        },
      };

      if (source === "activity") {
        const interfaceType = interfaces.find((i) => i.index === activityInterface)?.iface_type ?? 1;
        // Override the led's interface for trigger building
        (params.led as Record<string, unknown>).interface_index = activityInterface;
        (params.led as Record<string, unknown>).interface_type = interfaceType;

        params.colour = activityColour;
        if (triggerMode === "any") {
          params.trigger = { type: "AnyFrame" };
        } else if (triggerMode === "id") {
          params.trigger = { type: "FrameId", can_id: parseInt(canId, 16) || 0 };
        } else {
          const mask = [];
          for (let i = 0; i < 16; i += 2) {
            mask.push(parseInt(dataMask.substring(i, i + 2), 16) || 0);
          }
          params.trigger = { type: "FrameMatch", can_id: parseInt(canId, 16) || 0, mask };
        }
      } else if (source === "palette") {
        if (palSourceSignal == null) { setError(t("indicatorConfigDialog.errors.selectSource")); setSubmitting(false); return; }
        const palSig = selectableSignals.find((s) => s.signal_id === palSourceSignal);
        params.source_frame_def_id = palSig?.frame_def_id ?? null;
        params.source_signal_id = palSourceSignal;
        params.palette_signal_start = palettes[selectedPalette]?.signal_start ?? 0;
        params.signal_max = signalMax;
        if (gateSignalId) params.gate_signal_id = parseInt(gateSignalId);
      } else if (source === "threshold") {
        if (thrSourceSignal == null) { setError(t("indicatorConfigDialog.errors.selectSource")); setSubmitting(false); return; }
        const thrSig = selectableSignals.find((s) => s.signal_id === thrSourceSignal);
        params.source_frame_def_id = thrSig?.frame_def_id ?? null;
        params.source_signal_id = thrSourceSignal;
        params.threshold = threshold;
        params.value_above = valueAbove;
        params.value_below = valueBelow;
        if (thrGateSignalId) params.gate_signal_id = parseInt(thrGateSignalId);
      }

      await framelinkIndicatorConfigure(deviceId, params);
      onConfigured();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }, [source, led, deviceId, activityInterface, interfaces, triggerMode, canId, dataMask,
      activityColour, palSourceSignal, palettes, selectedPalette, signalMax, gateSignalId,
      thrSourceSignal, threshold, valueAbove, valueBelow, thrGateSignalId,
      selectableSignals, onConfigured, onClose, t]);

  // Note: activityColour is derived from led.colour, included in deps via led

  return (
    <Dialog
      isOpen={isOpen}
      onClose={closeWithValues}
      size="xl"
      title={t("indicatorConfigDialog.title", { label: led.label })}
    >
      <DialogBody>
        {error && (
          <Alert tone="danger" size="sm" className="mb-3">{error}</Alert>
        )}

        {/* State */}
        <div className="mb-4">
          <label className={labelDefault}>{t("indicatorConfigDialog.fields.state")}</label>
          <div className="flex gap-2">
            {STATE_KEYS.map((opt) => (
              <Button
                key={opt.value}
                onClick={() => writeState(opt.value)}
                variant="ghost"
                size="sm"
                pressed={ledState === opt.value}
              >
                {t(`indicatorConfigDialog.states.${opt.key}`)}
              </Button>
            ))}
          </div>
        </div>

        {/* Colour */}
        <div className="mb-4">
          <label className={labelDefault}>{t("indicatorConfigDialog.fields.colour")}</label>
          <ColourPicker value={ledColour} onChange={writeColour} />
        </div>

        {/* Blink period */}
        {ledState === 2 && led.blink_period_signal_id !== 0 && (
          <div className="mb-4">
            <label className={labelDefault}>{t("indicatorConfigDialog.fields.blinkPeriod")}</label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                size="sm"
                className="w-24"
                value={blinkPeriod}
                min={50}
                max={10000}
                step={50}
                onChange={(e) => setBlinkPeriod(parseInt(e.target.value) || 0)}
                onBlur={() => writeBlinkPeriod(blinkPeriod)}
              />
              <span className={`text-xs ${textTertiary}`}>{t("indicatorConfigDialog.fields.ms")}</span>
            </div>
          </div>
        )}

        <div className={`mb-4 pt-4 border-t border-[color:var(--border-default)]`}>
          <label className={labelDefault}>{t("indicatorConfigDialog.fields.trigger")}</label>
        </div>

        {/* Source type selector */}
        <div className="mb-4">
          <label className={labelDefault}>{t("indicatorConfigDialog.fields.indicatorSource")}</label>
          <div className="flex gap-2">
            {(["activity", "palette", "threshold"] as const).map((s) => (
              <Button
                key={s}
                onClick={() => setSource(s)}
                variant="ghost"
                size="sm"
                pressed={source === s}
              >
                {t(`indicatorConfigDialog.sources.${s}`)}
              </Button>
            ))}
          </div>
        </div>

        {/* Activity configuration */}
        {source === "activity" && (
          <div className="space-y-4">
            <div>
              <label className={labelDefault}>{t("indicatorConfigDialog.fields.interface")}</label>
              <Select
                size="lg"
                value={activityInterface}
                onChange={(e) => setActivityInterface(parseInt(e.target.value))}
              >
                {interfaces.map((iface) => (
                  <option key={iface.index} value={iface.index}>{iface.name}</option>
                ))}
              </Select>
            </div>
            <div>
              <label className={labelDefault}>{t("indicatorConfigDialog.fields.trigger")}</label>
              <Select
                size="lg"
                value={triggerMode}
                onChange={(e) => setTriggerMode(e.target.value as "any" | "id" | "match")}
              >
                <option value="any">{t("indicatorConfigDialog.triggers.any")}</option>
                <option value="id">{t("indicatorConfigDialog.triggers.id")}</option>
                <option value="match">{t("indicatorConfigDialog.triggers.match")}</option>
              </Select>
            </div>
            {(triggerMode === "id" || triggerMode === "match") && (
              <div>
                <label className={labelDefault}>{t("indicatorConfigDialog.fields.canId")}</label>
                <Input
                  type="text"
                  size="lg"
                  mono
                  className="w-32"
                  value={canId}
                  onChange={(e) => setCanId(e.target.value)}
                />
              </div>
            )}
            {triggerMode === "match" && (
              <div>
                <label className={labelDefault}>{t("indicatorConfigDialog.fields.dataMask")}</label>
                <Input
                  type="text"
                  size="lg"
                  mono
                  value={dataMask}
                  onChange={(e) => setDataMask(e.target.value)}
                  placeholder="FF00000000000000"
                />
              </div>
            )}
          </div>
        )}

        {/* Palette configuration */}
        {source === "palette" && (
          <div className="space-y-4">
            <div>
              <label className={labelDefault}>{t("indicatorConfigDialog.fields.sourceSignal")}</label>
              <SignalCombobox
                signals={selectableSignals}
                value={palSourceSignal}
                onChange={setPalSourceSignal}
              />
            </div>
            <div>
              <label className={labelDefault}>{t("indicatorConfigDialog.fields.palette")}</label>
              <Select size="lg" value={selectedPalette} onChange={(e) => setSelectedPalette(parseInt(e.target.value))}>
                {palettes.map((p, i) => (
                  <option key={i} value={i}>
                    {p.description ? t("indicatorConfigDialog.fields.paletteWithDesc", { name: p.name, description: p.description }) : p.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className={labelDefault}>{t("indicatorConfigDialog.fields.signalMax")}</label>
              <Input type="number" size="lg" className="w-32" value={signalMax} onChange={(e) => setSignalMax(parseInt(e.target.value) || 1000)} />
            </div>
            <div>
              <label className={labelDefault}>{t("indicatorConfigDialog.fields.gateSignal")}</label>
              <Input type="text" size="lg" mono className="w-32" value={gateSignalId} onChange={(e) => setGateSignalId(e.target.value)} placeholder={t("indicatorConfigDialog.fields.gatePlaceholder")} />
              <span className={`text-[10px] block mt-1 ${textTertiary}`}>{t("indicatorConfigDialog.fields.gateHint")}</span>
            </div>
          </div>
        )}

        {/* Threshold configuration */}
        {source === "threshold" && (
          <div className="space-y-4">
            <div>
              <label className={labelDefault}>{t("indicatorConfigDialog.fields.sourceSignal")}</label>
              <SignalCombobox
                signals={selectableSignals}
                value={thrSourceSignal}
                onChange={setThrSourceSignal}
              />
            </div>
            <div>
              <label className={labelDefault}>{t("indicatorConfigDialog.fields.thresholdValue")}</label>
              <Input type="number" size="lg" className="w-32" value={threshold} onChange={(e) => setThreshold(parseInt(e.target.value) || 0)} />
            </div>
            <div>
              <label className={labelDefault}>{t("indicatorConfigDialog.fields.colourAbove")}</label>
              <ColourPicker value={valueAbove} onChange={setValueAbove} />
            </div>
            <div>
              <label className={labelDefault}>{t("indicatorConfigDialog.fields.colourBelow")}</label>
              <ColourPicker value={valueBelow} onChange={setValueBelow} />
            </div>
            <div>
              <label className={labelDefault}>{t("indicatorConfigDialog.fields.gateSignal")}</label>
              <Input type="text" size="lg" mono className="w-32" value={thrGateSignalId} onChange={(e) => setThrGateSignalId(e.target.value)} placeholder={t("indicatorConfigDialog.fields.gatePlaceholder")} />
              <span className={`text-[10px] block mt-1 ${textTertiary}`}>{t("indicatorConfigDialog.fields.gateHint")}</span>
            </div>
          </div>
        )}
      </DialogBody>
      <DialogFooter className="justify-between">
        <Button
          onClick={handleClear}
          variant="ghost"
          tone="danger"
          size="lg"
        >
          {t("indicatorConfigDialog.clear")}
        </Button>
        <div className="flex gap-2">
          <SecondaryButton onClick={closeWithValues}>
            {t("indicatorConfigDialog.close")}
          </SecondaryButton>
          <PrimaryButton
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? t("indicatorConfigDialog.configuring") : t("indicatorConfigDialog.apply")}
          </PrimaryButton>
        </div>
      </DialogFooter>
    </Dialog>
  );
}

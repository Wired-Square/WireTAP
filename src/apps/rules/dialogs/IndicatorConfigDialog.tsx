// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// Indicator configuration dialog — mirrors the TUI's indicator edit wizard.
// Three source types: Activity (frame RX toggle), Palette (signal→colour),
// Threshold (signal above/below → colour).

import { useState, useEffect, useCallback, useRef } from "react";
import Dialog from "../../../components/Dialog";
import { inputSimple, labelDefault } from "../../../styles/inputStyles";
import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { panelFooter } from "../../../styles/cardStyles";
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

const COLOUR_WRITE_DEBOUNCE_MS = 150;
const DEFAULT_CAN_ID_HEX = "100";
const DEFAULT_DATA_MASK_HEX = "FF00000000000000";

const STATE_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 1, label: "On" },
  { value: 2, label: "Blink" },
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
        if (palSourceSignal == null) { setError("Select a source signal"); setSubmitting(false); return; }
        const palSig = selectableSignals.find((s) => s.signal_id === palSourceSignal);
        params.source_frame_def_id = palSig?.frame_def_id ?? null;
        params.source_signal_id = palSourceSignal;
        params.palette_signal_start = palettes[selectedPalette]?.signal_start ?? 0;
        params.signal_max = signalMax;
        if (gateSignalId) params.gate_signal_id = parseInt(gateSignalId);
      } else if (source === "threshold") {
        if (thrSourceSignal == null) { setError("Select a source signal"); setSubmitting(false); return; }
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
      selectableSignals, onConfigured, onClose]);

  // Note: activityColour is derived from led.colour, included in deps via led

  return (
    <Dialog isOpen={isOpen} onBackdropClick={closeWithValues} maxWidth="max-w-2xl">
      <div className="p-6 max-h-[80vh] overflow-y-auto">
        <h2 className={`text-lg font-semibold ${textPrimary} mb-4`}>
          Configure {led.label}
        </h2>

        {error && (
          <div className="mb-3 px-3 py-2 text-xs bg-red-500/10 border border-red-500/30 text-red-400 rounded">
            {error}
          </div>
        )}

        {/* State */}
        <div className="mb-4">
          <label className={labelDefault}>State</label>
          <div className="flex gap-2">
            {STATE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => writeState(opt.value)}
                className={`px-3 py-1.5 text-xs rounded-md ${
                  ledState === opt.value
                    ? "bg-indigo-500/30 text-indigo-300 font-medium"
                    : `${textSecondary} hover:bg-white/5`
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Colour */}
        <div className="mb-4">
          <label className={labelDefault}>Colour</label>
          <ColourPicker value={ledColour} onChange={writeColour} />
        </div>

        {/* Blink period */}
        {ledState === 2 && led.blink_period_signal_id !== 0 && (
          <div className="mb-4">
            <label className={labelDefault}>Blink Period</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                className={`${inputSimple} w-24 text-xs py-1 px-2`}
                value={blinkPeriod}
                min={50}
                max={10000}
                step={50}
                onChange={(e) => setBlinkPeriod(parseInt(e.target.value) || 0)}
                onBlur={() => writeBlinkPeriod(blinkPeriod)}
              />
              <span className={`text-xs ${textTertiary}`}>ms</span>
            </div>
          </div>
        )}

        <div className={`mb-4 pt-4 border-t border-[color:var(--border-default)]`}>
          <label className={labelDefault}>Trigger</label>
        </div>

        {/* Source type selector */}
        <div className="mb-4">
          <label className={labelDefault}>Indicator Source</label>
          <div className="flex gap-2">
            {(["activity", "palette", "threshold"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSource(s)}
                className={`px-3 py-1.5 text-xs rounded-md ${
                  source === s
                    ? "bg-indigo-500/30 text-indigo-300 font-medium"
                    : `${textSecondary} hover:bg-white/5`
                }`}
              >
                {s === "activity" ? "Activity" : s === "palette" ? "Signal → Colour" : "Signal → Threshold"}
              </button>
            ))}
          </div>
        </div>

        {/* Activity configuration */}
        {source === "activity" && (
          <div className="space-y-4">
            <div>
              <label className={labelDefault}>Interface</label>
              <select
                className={inputSimple}
                value={activityInterface}
                onChange={(e) => setActivityInterface(parseInt(e.target.value))}
              >
                {interfaces.map((iface) => (
                  <option key={iface.index} value={iface.index}>{iface.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelDefault}>Trigger</label>
              <select
                className={inputSimple}
                value={triggerMode}
                onChange={(e) => setTriggerMode(e.target.value as "any" | "id" | "match")}
              >
                <option value="any">Any frame</option>
                <option value="id">Specific CAN ID</option>
                <option value="match">Frame match (ID + data mask)</option>
              </select>
            </div>
            {(triggerMode === "id" || triggerMode === "match") && (
              <div>
                <label className={labelDefault}>CAN ID (hex)</label>
                <input
                  type="text"
                  className={`${inputSimple} font-mono w-32`}
                  value={canId}
                  onChange={(e) => setCanId(e.target.value)}
                />
              </div>
            )}
            {triggerMode === "match" && (
              <div>
                <label className={labelDefault}>Data mask (hex bytes)</label>
                <input
                  type="text"
                  className={`${inputSimple} font-mono`}
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
              <label className={labelDefault}>Source Signal</label>
              <SignalCombobox
                signals={selectableSignals}
                value={palSourceSignal}
                onChange={setPalSourceSignal}
              />
            </div>
            <div>
              <label className={labelDefault}>Palette</label>
              <select className={inputSimple} value={selectedPalette} onChange={(e) => setSelectedPalette(parseInt(e.target.value))}>
                {palettes.map((p, i) => (
                  <option key={i} value={i}>{p.name}{p.description ? ` — ${p.description}` : ""}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelDefault}>Signal Max (normalisation denominator)</label>
              <input type="number" className={`${inputSimple} w-32`} value={signalMax} onChange={(e) => setSignalMax(parseInt(e.target.value) || 1000)} />
            </div>
            <div>
              <label className={labelDefault}>Gate Signal (optional)</label>
              <input type="text" className={`${inputSimple} font-mono w-32`} value={gateSignalId} onChange={(e) => setGateSignalId(e.target.value)} placeholder="Signal ID" />
              <span className={`text-[10px] block mt-1 ${textTertiary}`}>Leave empty for no gate</span>
            </div>
          </div>
        )}

        {/* Threshold configuration */}
        {source === "threshold" && (
          <div className="space-y-4">
            <div>
              <label className={labelDefault}>Source Signal</label>
              <SignalCombobox
                signals={selectableSignals}
                value={thrSourceSignal}
                onChange={setThrSourceSignal}
              />
            </div>
            <div>
              <label className={labelDefault}>Threshold Value</label>
              <input type="number" className={`${inputSimple} w-32`} value={threshold} onChange={(e) => setThreshold(parseInt(e.target.value) || 0)} />
            </div>
            <div>
              <label className={labelDefault}>Colour Above Threshold</label>
              <ColourPicker value={valueAbove} onChange={setValueAbove} />
            </div>
            <div>
              <label className={labelDefault}>Colour Below Threshold (0 = Off)</label>
              <ColourPicker value={valueBelow} onChange={setValueBelow} />
            </div>
            <div>
              <label className={labelDefault}>Gate Signal (optional)</label>
              <input type="text" className={`${inputSimple} font-mono w-32`} value={thrGateSignalId} onChange={(e) => setThrGateSignalId(e.target.value)} placeholder="Signal ID" />
              <span className={`text-[10px] block mt-1 ${textTertiary}`}>Leave empty for no gate</span>
            </div>
          </div>
        )}
      </div>

      <div className={`${panelFooter} flex justify-between`}>
        <button
          onClick={handleClear}
          className={`px-4 py-2 text-sm rounded ${textSecondary} hover:bg-red-500/20 hover:text-red-400`}
        >
          Clear Indicator
        </button>
        <div className="flex gap-2">
          <button onClick={closeWithValues} className={`px-4 py-2 text-sm rounded ${textSecondary} hover:bg-white/10`}>
            Close
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
          >
            {submitting ? "Configuring..." : "Apply Trigger"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

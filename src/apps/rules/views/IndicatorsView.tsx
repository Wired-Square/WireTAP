// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// Indicator tab — discovers LED indicators via the backend (which uses
// framelink::board::discover_leds from the library) and provides controls
// to change colour, state, and blink period.

import { useEffect, useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { Loader2, RefreshCw, Palette } from "lucide-react";
import { useRulesStore } from "../stores/rulesStore";
import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { cardDefault, cardPadding } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import IndicatorSprite, { IndicatorSpriteDefs } from "../components/IndicatorSprite";
import { brgbToCss } from "../utils/brgbColour";
import {
  framelinkIndicatorsList,
  type DiscoveredLed,
} from "../../../api/framelinkRules";
import PaletteEditorDialog from "../dialogs/PaletteEditorDialog";
import IndicatorConfigDialog, { type LedUpdateValues } from "../dialogs/IndicatorConfigDialog";

const STATE_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 1, label: "On" },
  { value: 2, label: "Blink" },
] as const;

export default function IndicatorsView() {
  const { deviceId, deviceInterfaces, frameDefs } = useRulesStore(
    useShallow((s) => ({
      deviceId: s.device?.deviceId ?? null,
      deviceInterfaces: s.device?.interfaces ?? [],
      frameDefs: s.frameDefs,
    })),
  );

  const [indicators, setIndicators] = useState<DiscoveredLed[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [configLed, setConfigLed] = useState<DiscoveredLed | null>(null);

  const loadIndicators = useCallback(async () => {
    if (!deviceId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await framelinkIndicatorsList(deviceId);
      setIndicators(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    loadIndicators();
  }, [loadIndicators]);

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="ml-2 text-sm">Discovering indicators...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  if (indicators.length === 0) {
    return (
      <div className={`flex items-center justify-center py-12 ${textTertiary}`}>
        <p className="text-sm">No LED indicators found on device</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <IndicatorSpriteDefs />
      <div className="flex justify-end gap-2 mb-1">
        <button
          onClick={() => setPaletteOpen(true)}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          <Palette className={iconMd} /> Palette Editor
        </button>
        <button
          onClick={loadIndicators}
          className={`p-1 rounded hover:bg-white/10 ${textSecondary}`}
          title="Refresh indicators"
        >
          <RefreshCw className={iconMd} />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {indicators.map((led) => {
          const cssColour = brgbToCss(led.colour);
          const spriteState =
            led.state === 2 ? "blink" : led.state === 1 ? "on" : "off";

          return (
            <button
              key={led.index}
              className={`${cardDefault} ${cardPadding.md} flex items-center gap-3 w-full text-left cursor-pointer hover:brightness-110 transition-all`}
              onClick={() => setConfigLed(led)}
            >
              <IndicatorSprite
                colour={cssColour}
                state={spriteState}
                size={40}
              />
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${textPrimary}`}>
                  {led.label}
                </div>
                <div className={`text-xs ${textSecondary}`}>
                  {STATE_OPTIONS[led.state]?.label ?? "Unknown"}
                  {led.state === 2 && led.blink_period > 0
                    ? ` · ${led.blink_period}ms`
                    : ""}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {deviceId && (
        <PaletteEditorDialog
          isOpen={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          deviceId={deviceId}
        />
      )}

      {deviceId && configLed && (
        <IndicatorConfigDialog
          key={configLed.index}
          isOpen={!!configLed}
          onClose={(updated?: LedUpdateValues) => {
            if (updated) {
              setIndicators((prev) =>
                prev.map((led) =>
                  led.index === configLed.index ? { ...led, ...updated } : led,
                ),
              );
            }
            setConfigLed(null);
          }}
          onConfigured={loadIndicators}
          deviceId={deviceId}
          led={configLed}
          interfaces={deviceInterfaces}
          frameDefs={frameDefs}
        />
      )}
    </div>
  );
}

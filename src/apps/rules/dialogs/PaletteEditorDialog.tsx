// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// Palette editor — select a board palette, preview its gradient, edit colour
// stops, and upload entries to the device as user signals.

import { useState, useEffect, useCallback } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import Dialog from "../../../components/Dialog";
import { inputSimple, labelDefault } from "../../../styles/inputStyles";
import { textPrimary, textSecondary, textTertiary, borderDefault } from "../../../styles";
import { panelFooter } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import ColourPicker from "../components/ColourPicker";
import PalettePreview from "../components/PalettePreview";
import { brgbToCss, cssToBrgb } from "../utils/brgbColour";
import { formatHexId } from "../utils/formatHex";
import {
  framelinkPalettesList,
  framelinkDsigWrite,
  type PaletteInfo,
} from "../../../api/framelinkRules";

interface PaletteEditorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  deviceId: string;
}

export default function PaletteEditorDialog({
  isOpen,
  onClose,
  deviceId,
}: PaletteEditorDialogProps) {
  const [palettes, setPalettes] = useState<PaletteInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [entries, setEntries] = useState<number[]>([]);
  const [editingStop, setEditingStop] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load palettes from board def on open
  useEffect(() => {
    if (!isOpen || !deviceId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await framelinkPalettesList(deviceId);
        if (!cancelled) {
          setPalettes(result);
          if (result.length > 0) {
            setSelectedIdx(0);
            setEntries([...result[0].entries]);
          }
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, deviceId]);

  const selectedPalette = palettes[selectedIdx] ?? null;

  const handleSelectPalette = useCallback(
    (idx: number) => {
      setSelectedIdx(idx);
      if (palettes[idx]) {
        setEntries([...palettes[idx].entries]);
        setEditingStop(null);
      }
    },
    [palettes],
  );

  const updateEntry = useCallback((stopIdx: number, brgb: number) => {
    setEntries((prev) => prev.map((e, i) => (i === stopIdx ? brgb : e)));
  }, []);

  const addStop = useCallback(() => {
    setEntries((prev) => [...prev, cssToBrgb(255, 255, 255, 255)]);
  }, []);

  const removeStop = useCallback((stopIdx: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== stopIdx));
    setEditingStop(null);
  }, []);

  const handleUpload = useCallback(async () => {
    if (!selectedPalette || !deviceId) return;
    setUploading(true);
    setError(null);
    try {
      // Write each entry as a user signal starting at signal_start
      for (let i = 0; i < entries.length; i++) {
        await framelinkDsigWrite(
          deviceId,
          selectedPalette.signal_start + i,
          entries[i],
        );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  }, [selectedPalette, deviceId, entries]);

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-2xl">
      <div className="p-6">
        <h2 className={`text-lg font-semibold ${textPrimary} mb-4`}>
          Palette Editor
        </h2>

        {loading && (
          <div className={`flex items-center justify-center py-8 ${textTertiary}`}>
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="ml-2 text-sm">Loading palettes...</span>
          </div>
        )}

        {error && (
          <div className="mb-3 px-3 py-2 text-xs bg-red-500/10 border border-red-500/30 text-red-400 rounded">
            {error}
          </div>
        )}

        {!loading && palettes.length === 0 && (
          <p className={`text-sm ${textTertiary} py-4`}>
            No palettes defined in board definition
          </p>
        )}

        {!loading && palettes.length > 0 && (
          <div className="space-y-4">
            {/* Palette selector */}
            <div>
              <label className={labelDefault}>Palette</label>
              <select
                className={inputSimple}
                value={selectedIdx}
                onChange={(e) => handleSelectPalette(parseInt(e.target.value))}
              >
                {palettes.map((p, i) => (
                  <option key={i} value={i}>
                    {p.name}
                    {p.description ? ` — ${p.description}` : ""}
                  </option>
                ))}
              </select>
            </div>

            {/* Gradient preview */}
            <div>
              <span className={`text-[10px] uppercase tracking-wider ${textTertiary}`}>
                Preview
              </span>
              <div className="mt-1">
                <PalettePreview entries={entries} height={24} />
              </div>
            </div>

            {/* Colour stops */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-[10px] uppercase tracking-wider ${textTertiary}`}>
                  Colour Stops ({entries.length})
                </span>
                <button
                  onClick={addStop}
                  className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                >
                  <Plus className={iconMd} /> Add
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                {entries.map((brgb, i) => (
                  <div key={i} className="flex flex-col items-center gap-1">
                    <button
                      className={`w-8 h-8 rounded border-2 ${editingStop === i ? "border-indigo-400" : "border-white/20"}`}
                      style={{ backgroundColor: brgbToCss(brgb) }}
                      onClick={() =>
                        setEditingStop(editingStop === i ? null : i)
                      }
                      title={`Stop ${i}`}
                    />
                    <span className={`text-[9px] ${textTertiary}`}>{i}</span>
                  </div>
                ))}
              </div>

              {/* Expanded stop editor */}
              {editingStop != null && editingStop < entries.length && (
                <div className={`mt-3 p-3 border ${borderDefault} rounded-lg`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-xs font-medium ${textSecondary}`}>
                      Stop {editingStop}
                    </span>
                    <button
                      onClick={() => removeStop(editingStop)}
                      className={`p-0.5 rounded hover:bg-red-500/20 ${textTertiary} hover:text-red-400`}
                      title="Remove stop"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <ColourPicker
                    value={entries[editingStop]}
                    onChange={(brgb) => updateEntry(editingStop, brgb)}
                  />
                </div>
              )}
            </div>

            {selectedPalette && (
              <div className={`text-xs ${textTertiary}`}>
                Signal start: {formatHexId(selectedPalette.signal_start)}
                {` · ${entries.length} entries`}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={`${panelFooter} flex justify-end gap-2`}>
        <button
          onClick={onClose}
          className={`px-4 py-2 text-sm rounded ${textSecondary} hover:bg-white/10`}
        >
          Cancel
        </button>
        <button
          onClick={handleUpload}
          disabled={!selectedPalette || uploading || entries.length === 0}
          className="px-4 py-2 text-sm font-medium rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
        >
          {uploading ? "Uploading..." : "Upload to Device"}
        </button>
      </div>
    </Dialog>
  );
}

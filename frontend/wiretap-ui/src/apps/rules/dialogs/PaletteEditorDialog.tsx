// Copyright 2026 Wired Square Pty Ltd
//
// Palette editor — select a board palette, preview its gradient, edit colour
// stops, and upload entries to the device as user signals.

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Plus, Trash2 } from "lucide-react";
import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { labelDefault } from "../../../styles/typography";
import { textSecondary, borderDefault } from "../../../styles";
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
import { Button, IconButton } from "../../../components/Button";
import { SecondaryButton, PrimaryButton, Select } from "../../../components/forms";
import { Alert } from "../../../components/Alert";
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
  const { t } = useTranslation("rules");
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
    <Dialog isOpen={isOpen} onClose={onClose} size="xl" title={t("paletteDialog.title")}>
      <DialogBody>
        {loading && (
          <div className={`flex items-center justify-center py-8 ${textSecondary}`}>
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="ml-2 text-sm">{t("paletteDialog.loading")}</span>
          </div>
        )}

        {error && (
          <Alert tone="danger" size="sm" className="mb-3">{error}</Alert>
        )}

        {!loading && palettes.length === 0 && (
          <p className={`text-sm ${textSecondary} py-4`}>
            {t("paletteDialog.noPalettes")}
          </p>
        )}

        {!loading && palettes.length > 0 && (
          <div className="space-y-4">
            {/* Palette selector */}
            <div>
              <label className={labelDefault}>{t("paletteDialog.fields.palette")}</label>
              <Select
                size="lg"
                value={selectedIdx}
                onChange={(e) => handleSelectPalette(parseInt(e.target.value))}
              >
                {palettes.map((p, i) => (
                  <option key={i} value={i}>
                    {p.description
                      ? t("paletteDialog.fields.paletteWithDesc", { name: p.name, description: p.description })
                      : p.name}
                  </option>
                ))}
              </Select>
            </div>

            {/* Gradient preview */}
            <div>
              <span className={`text-2xs uppercase tracking-wider ${textSecondary}`}>
                {t("paletteDialog.fields.preview")}
              </span>
              <div className="mt-1">
                <PalettePreview entries={entries} height={24} />
              </div>
            </div>

            {/* Colour stops */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-2xs uppercase tracking-wider ${textSecondary}`}>
                  {t("paletteDialog.fields.colourStops", { count: entries.length })}
                </span>
                <Button
                  onClick={addStop}
                  variant="link"
                  tone="primary"
                  className="text-xs"
                >
                  <Plus className={iconMd} /> {t("paletteDialog.fields.add")}
                </Button>
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
                      title={t("paletteDialog.fields.stopTitle", { index: i })}
                    />
                    <span className={`text-2xs ${textSecondary}`}>{i}</span>
                  </div>
                ))}
              </div>

              {/* Expanded stop editor */}
              {editingStop != null && editingStop < entries.length && (
                <div className={`mt-3 p-3 border ${borderDefault} rounded-lg`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-xs font-medium ${textSecondary}`}>
                      {t("paletteDialog.fields.stopHeading", { index: editingStop })}
                    </span>
                    <IconButton
                      onClick={() => removeStop(editingStop)}
                      tone="danger"
                      size="xs"
                      title={t("paletteDialog.fields.removeStop")}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </IconButton>
                  </div>
                  <ColourPicker
                    value={entries[editingStop]}
                    onChange={(brgb) => updateEntry(editingStop, brgb)}
                  />
                </div>
              )}
            </div>

            {selectedPalette && (
              <div className={`text-xs ${textSecondary}`}>
                {t("paletteDialog.fields.summary", {
                  id: formatHexId(selectedPalette.signal_start),
                  count: entries.length,
                })}
              </div>
            )}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <SecondaryButton
          onClick={onClose}
        >
          {t("paletteDialog.cancel")}
        </SecondaryButton>
        <PrimaryButton
          onClick={handleUpload}
          disabled={!selectedPalette || uploading || entries.length === 0}
        >
          {uploading ? t("paletteDialog.uploading") : t("paletteDialog.upload")}
        </PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}

// ui/src/dialogs/SaveFramesDialog.tsx

import { useState, useEffect } from 'react';
import { AlertCircle } from 'lucide-react';
import { iconXs, flexRowGap2 } from '../styles/spacing';
import Dialog from '../components/Dialog';
import { Input, Select, FormField } from '../components/forms';
import { SecondaryButton } from '../components/forms/DialogButtons';
import { listCatalogs } from '../api/catalog';
import {
  h3,
  paddingDialog,
  spaceYDefault,
  gapSmall,
  textSuccess,
  textMuted,
} from '../styles';

export type FrameMetadata = {
  name: string;
  version: number;
  default_byte_order: "little" | "big";
  default_interval: number;
  filename: string;
};

export type SaveFramesDialogProps = {
  open: boolean;
  meta: FrameMetadata;
  decoderDir: string;
  knowledgeInterval?: number | null;
  knowledgeEndianness?: 'little' | 'big' | null;
  onChange: (next: FrameMetadata) => void;
  onCancel: () => void;
  onSave: () => void;
};

/**
 * Shared dialog for exporting frames to TOML catalog format.
 * Used in both Discovery and Decoder apps.
 */
export default function SaveFramesDialog({ open, meta, decoderDir, knowledgeInterval, knowledgeEndianness, onChange, onCancel, onSave }: SaveFramesDialogProps) {
  const [existingFiles, setExistingFiles] = useState<Set<string>>(new Set());
  const [filenameError, setFilenameError] = useState<string | null>(null);

  // Load existing catalog filenames when dialog opens
  useEffect(() => {
    if (open && decoderDir) {
      listCatalogs(decoderDir)
        .then((catalogs) => {
          setExistingFiles(new Set(catalogs.map((c) => c.filename.toLowerCase())));
        })
        .catch(() => {
          setExistingFiles(new Set());
        });
    }
  }, [open, decoderDir]);

  // Check if filename already exists
  useEffect(() => {
    const normalizedFilename = meta.filename.trim().toLowerCase();
    const filenameWithExt = normalizedFilename.endsWith('.toml')
      ? normalizedFilename
      : `${normalizedFilename}.toml`;

    if (normalizedFilename && existingFiles.has(filenameWithExt)) {
      setFilenameError('A file with this name already exists');
    } else {
      setFilenameError(null);
    }
  }, [meta.filename, existingFiles]);

  // Determine the interval to display - use knowledge interval if available
  const displayInterval = knowledgeInterval ?? meta.default_interval;

  return (
    <Dialog isOpen={open} maxWidth="max-w-lg">
      <div className={`${paddingDialog} ${spaceYDefault}`}>
        <div className={h3}>Export Boilerplate Decoder</div>

        <div className={`grid grid-cols-1 ${gapSmall}`}>
          <FormField label="Name" variant="simple">
            <Input
              variant="simple"
              value={meta.name}
              onChange={(e) => onChange({ ...meta, name: e.target.value })}
            />
          </FormField>

          <FormField label="Version" variant="simple">
            <Input
              variant="simple"
              type="number"
              min={1}
              value={meta.version}
              onChange={(e) => onChange({ ...meta, version: Number(e.target.value) || 1 })}
            />
          </FormField>

          <FormField label="Default byte order" variant="simple">
            <div className={flexRowGap2}>
              <Select
                variant="simple"
                value={knowledgeEndianness ?? meta.default_byte_order}
                onChange={(e) =>
                  onChange({
                    ...meta,
                    default_byte_order: e.target.value === "big" ? "big" : "little",
                  })
                }
                className="flex-1"
              >
                <option value="little">Little</option>
                <option value="big">Big</option>
              </Select>
              <span className={`text-xs whitespace-nowrap ${
                knowledgeEndianness !== null && knowledgeEndianness !== undefined
                  ? textSuccess
                  : textMuted
              }`}>
                {knowledgeEndianness !== null && knowledgeEndianness !== undefined ? 'from analysis' : 'default'}
              </span>
            </div>
          </FormField>

          <FormField label="Default interval (ms)" variant="simple">
            <div className={flexRowGap2}>
              <Input
                variant="simple"
                type="number"
                min={0}
                value={displayInterval}
                onChange={(e) => onChange({ ...meta, default_interval: Number(e.target.value) || 0 })}
                className="flex-1"
              />
              <span className={`text-xs whitespace-nowrap ${
                knowledgeInterval !== null && knowledgeInterval !== undefined
                  ? textSuccess
                  : textMuted
              }`}>
                {knowledgeInterval !== null && knowledgeInterval !== undefined ? 'from analysis' : 'default'}
              </span>
            </div>
          </FormField>

          <FormField label="Filename" variant="simple">
            <div className="space-y-1">
              <Input
                variant="simple"
                value={meta.filename}
                onChange={(e) => onChange({ ...meta, filename: e.target.value })}
                placeholder="my-decoder.toml"
                className={filenameError ? 'border-[color:var(--text-amber)]' : ''}
              />
              {filenameError && (
                <div className="flex items-center gap-1 text-xs text-[color:var(--text-amber)]">
                  <AlertCircle className={iconXs} />
                  {filenameError}
                </div>
              )}
            </div>
          </FormField>
        </div>

        <div className={`flex justify-end ${gapSmall} pt-2`}>
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <button
            onClick={onSave}
            className="px-4 py-2 rounded-lg text-sm bg-green-600 text-white hover:bg-green-700 transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </Dialog>
  );
}

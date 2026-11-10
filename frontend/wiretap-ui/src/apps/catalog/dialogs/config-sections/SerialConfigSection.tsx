// ui/src/apps/catalog/dialogs/config-sections/SerialConfigSection.tsx
// Serial protocol configuration section for unified config dialog

import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Cable, Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../../../styles/spacing";
import { caption, textMedium } from "../../../../styles";
import type { SerialHeaderFieldEntry } from "../../../../stores/catalogEditorStore";
import type { HeaderFieldFormat, ChecksumAlgorithm } from "../../types";
import type { SerialChecksumFields } from "../../../../types/catalogEdit";
import type { FramingMode } from "../../../../generated/FramingMode";
import MaskBitPicker from "../../../../components/MaskBitPicker";
import { CHECKSUM_ALGORITHMS } from "../../../../utils/analysis/checksums";
import { Button, IconButton } from "../../../../components/Button";
import { Select, Input, Checkbox } from "../../../../components/forms";
import { Badge } from "../../../../components/Badge";
import { Card } from "../../../../components/Card";
import { protocolLabel } from "../../../../utils/profileTraits";
import { ConfigSectionHeader } from "./ConfigSectionHeader";
import SerialEncodingSelect from "./SerialEncodingSelect";
/** Predefined header field types */
type FieldType = "id" | "source_address" | "destination_address" | "custom";

const FIELD_TYPES: FieldType[] = ["id", "source_address", "destination_address", "custom"];

/** Format a mask number as a hex string */
function formatMaskHex(mask: number, numBytes: number = 2): string {
  const hexDigits = numBytes * 2;
  return `0x${mask.toString(16).toUpperCase().padStart(hexDigits, '0')}`;
}

/** Compute byte position info from mask */
function computeByteInfo(mask: number, headerLength: number, t: TFunction): string {
  if (mask === 0 || headerLength === 0) return t("configSections.noBitsSelected");

  // Find first and last set bit
  let firstBit = -1;
  let lastBit = -1;
  for (let i = 0; i < headerLength * 8; i++) {
    if ((mask >> i) & 1) {
      if (firstBit === -1) firstBit = i;
      lastBit = i;
    }
  }

  if (firstBit === -1) return t("configSections.noBitsSelected");

  const numBits = lastBit - firstBit + 1;
  return t("configSections.serial.byteInfo", { count: Math.ceil(numBits / 8), offset: Math.floor(firstBit / 8) });
}

export type SerialConfigSectionProps = {
  isConfigured: boolean;
  hasFrames: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onAdd: () => void;
  onRemove: () => void;
  // Config values (only used when configured)
  encoding: FramingMode | null;
  setEncoding: (encoding: FramingMode) => void;
  byteOrder: "little" | "big";
  setByteOrder: (byteOrder: "little" | "big") => void;
  headerFields: SerialHeaderFieldEntry[];
  setHeaderFields: (fields: SerialHeaderFieldEntry[]) => void;
  headerLength: number | undefined;
  setHeaderLength: (length: number | undefined) => void;
  checksum: SerialChecksumFields | null;
  setChecksum: (checksum: SerialChecksumFields | null) => void;
};

export default function SerialConfigSection({
  isConfigured,
  hasFrames,
  isExpanded,
  onToggleExpanded,
  onAdd,
  onRemove,
  encoding,
  setEncoding,
  byteOrder,
  setByteOrder,
  headerFields,
  setHeaderFields,
  headerLength,
  setHeaderLength,
  checksum,
  setChecksum,
}: SerialConfigSectionProps) {
  const { t } = useTranslation("catalog");
  // State for inline add form
  const [isAddingField, setIsAddingField] = useState(false);
  const [newFieldType, setNewFieldType] = useState<FieldType>("id");
  const [newFieldCustomName, setNewFieldCustomName] = useState("");
  const [newFieldEndianness, setNewFieldEndianness] = useState<"big" | "little">("big");
  const [newFieldFormat, setNewFieldFormat] = useState<HeaderFieldFormat>("hex");

  // State for field bit pickers (which fields have expanded picker)
  const [expandedFieldPickers, setExpandedFieldPickers] = useState<Record<number, boolean>>({});

  // Effective header length (default to 2 if not set)
  const effectiveHeaderLength = headerLength ?? 2;

  // Check if 'id' field already exists
  const hasIdField = useMemo(
    () => headerFields.some((f) => f.name.toLowerCase() === "id"),
    [headerFields]
  );

  const resetAddForm = () => {
    setNewFieldType("id");
    setNewFieldCustomName("");
    setNewFieldEndianness("big");
    setNewFieldFormat("hex");
    setIsAddingField(false);
  };

  const handleAddField = () => {
    const name = newFieldType === "custom"
      ? newFieldCustomName.trim()
      : newFieldType;

    if (!name) return;

    // Default mask covers all header bytes
    const defaultMask = ((1 << (effectiveHeaderLength * 8)) - 1) >>> 0;

    const newField: SerialHeaderFieldEntry = {
      name,
      mask: defaultMask,
      endianness: newFieldEndianness,
      format: newFieldFormat,
    };

    setHeaderFields([...headerFields, newField]);

    // Auto-expand the bit picker for the new field
    setExpandedFieldPickers((prev) => ({
      ...prev,
      [headerFields.length]: true,
    }));

    resetAddForm();
  };

  const handleRemoveField = (index: number) => {
    setHeaderFields(headerFields.filter((_, i) => i !== index));
    // Clean up expanded state
    setExpandedFieldPickers((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const handleUpdateField = (index: number, updates: Partial<SerialHeaderFieldEntry>) => {
    setHeaderFields(
      headerFields.map((field, i) =>
        i === index ? { ...field, ...updates } : field
      )
    );
  };

  const toggleFieldPicker = (index: number) => {
    setExpandedFieldPickers((prev) => ({
      ...prev,
      [index]: !prev[index],
    }));
  };

  const handleFieldMaskChange = useCallback((index: number, mask: number, shift: number) => {
    const fullMask = (mask << shift) >>> 0;
    handleUpdateField(index, { mask: fullMask });
  }, [headerFields]);

  // Checksum helpers
  const handleAddChecksum = () => {
    setChecksum({
      algorithm: "sum8" as ChecksumAlgorithm,
      start_byte: -1,
      byte_length: 1,
      calc_start_byte: 0,
      calc_end_byte: -1,
    });
  };

  const handleRemoveChecksum = () => {
    setChecksum(null);
  };

  const handleUpdateChecksum = (updates: Partial<SerialChecksumFields>) => {
    if (checksum) {
      setChecksum({ ...checksum, ...updates });
    }
  };

  const showWarning = hasFrames && !isConfigured;

  const availableFieldTypes = FIELD_TYPES.map((value) => ({
    value,
    label: t(`configSections.fieldTypes.${value}`),
    disabled: value === "id" && hasIdField,
  }));

  return (
    <Card padding="none" className="overflow-hidden">
      <ConfigSectionHeader
        label={protocolLabel("serial")}
        icon={<Cable className={iconMd} />}
        tone="purple"
        isConfigured={isConfigured}
        showWarning={showWarning}
        isExpanded={isExpanded}
        onToggleExpanded={onToggleExpanded}
        onAdd={onAdd}
        onRemove={onRemove}
      />

      {isExpanded && isConfigured && (
        <div className="p-4 space-y-4 border-t border-default">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={`block ${textMedium} mb-2`}>
                {t("serialConfig.encoding")} <span className="text-danger">*</span>
              </label>
              <SerialEncodingSelect value={encoding} onChange={setEncoding} />
            </div>

            <div>
              <label className={`block ${textMedium} mb-2`}>
                {t("configSections.serial.byteOrder")} <span className="text-danger">*</span>
              </label>
              <Select
                value={byteOrder}
                onChange={(e) => setByteOrder(e.target.value as "little" | "big")}
                size="lg"
              >
                <option value="big">{t("configSections.serial.bigEndian")}</option>
                <option value="little">{t("configSections.serial.littleEndian")}</option>
              </Select>
              <p className={`mt-1 ${caption}`}>
                {t("configSections.serial.byteOrderHint")}
              </p>
            </div>
          </div>

          <div className="border-t border-default pt-4 mt-4">
            <h3 className={`${textMedium} mb-3`}>{t("configSections.serial.header")}</h3>

            <div className="mb-4">
              <label className="block text-xs font-medium text-secondary mb-1">
                {t("configSections.serial.headerLength")}
              </label>
              <Input
                type="number"
                min={1}
                max={8}
                value={headerLength ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setHeaderLength(val === "" ? undefined : Math.max(1, Math.min(8, parseInt(val) || 1)));
                }}
                size="lg"
                className="w-24"
                placeholder="2"
              />
              <p className={`mt-1 ${caption}`}>
                {t("configSections.serial.headerLengthHint")}
              </p>
            </div>
          </div>

          <div className="border-t border-default pt-4 mt-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className={textMedium}>{t("configSections.headerFields")}</h3>
                <p className={caption}>{t("configSections.serial.headerFieldsHint")}</p>
              </div>
              {!isAddingField && (
                <Button
                  onClick={() => setIsAddingField(true)}
                  variant="tonal"
                  tone="purple"
                >
                  <Plus className={iconMd} />
                  {t("shared.addField")}
                </Button>
              )}
            </div>

            {headerFields.length > 0 && (
              <div className="space-y-2 mb-3">
                {headerFields.map((field, index) => (
                  <div key={index} className="space-y-2">
                    <Card padding="sm" className="flex items-center gap-2">
                      <IconButton
                        onClick={() => toggleFieldPicker(index)}
                        size="sm"
                        disabled={field.mask === undefined}
                        title={expandedFieldPickers[index] ? t("shared.hideBitPicker") : t("shared.showBitPicker")}
                      >
                        {expandedFieldPickers[index] ? (
                          <ChevronDown className={iconMd} />
                        ) : (
                          <ChevronRight className={iconMd} />
                        )}
                      </IconButton>

                      <span className="w-28 font-medium text-sm text-primary truncate">
                        {field.name}
                      </span>

                      {field.mask === undefined ? (
                        <>
                          <Input
                            type="number"
                            size="sm"
                            className="w-16"
                            title={t("configSections.serial.startByteTooltip")}
                            value={field.startByte ?? 0}
                            onChange={(e) => handleUpdateField(index, { startByte: Number(e.target.value) })}
                          />
                          <Input
                            type="number"
                            size="sm"
                            className="w-16"
                            min={1}
                            title={t("configSections.serial.bytesTooltip")}
                            value={field.bytes ?? 1}
                            onChange={(e) => handleUpdateField(index, { bytes: Number(e.target.value) })}
                          />
                        </>
                      ) : (
                        <>
                          <Badge mono>{formatMaskHex(field.mask, effectiveHeaderLength)}</Badge>
                          <span className={caption}>
                            ({computeByteInfo(field.mask, effectiveHeaderLength, t)})
                          </span>
                        </>
                      )}

                      <div className="flex-1" />

                      <Select
                        value={field.endianness}
                        onChange={(e) => handleUpdateField(index, { endianness: e.target.value as "big" | "little" })}
                        size="sm"
                        className="w-16"
                        title={t("configSections.serial.byteOrderTooltip")}
                      >
                        <option value="big">BE</option>
                        <option value="little">LE</option>
                      </Select>

                      <Select
                        value={field.format}
                        onChange={(e) => handleUpdateField(index, { format: e.target.value as HeaderFieldFormat })}
                        size="sm"
                        className="w-16"
                      >
                        <option value="hex">{t("common:frameIdFormat.hex")}</option>
                        <option value="decimal">{t("common:frameIdFormat.dec")}</option>
                      </Select>

                      <IconButton
                        onClick={() => handleRemoveField(index)}
                        tone="danger"
                        size="sm"
                        title={t("configSections.removeField")}
                      >
                        <Trash2 className={iconMd} />
                      </IconButton>
                    </Card>

                    {expandedFieldPickers[index] && field.mask !== undefined && (
                      <Card className="ml-8">
                        <MaskBitPicker
                          mask={field.mask}
                          shift={0}
                          onMaskChange={(mask, shift) => handleFieldMaskChange(index, mask, shift)}
                          numBytes={effectiveHeaderLength}
                        />
                      </Card>
                    )}
                  </div>
                ))}
              </div>
            )}

            {isAddingField && (
              <div className="p-3 bg-purple rounded-lg border border-purple">
                <div className="flex items-center gap-2 mb-3">
                  <Select
                    value={newFieldType}
                    onChange={(e) => setNewFieldType(e.target.value as FieldType)}
                    className="w-40"
                  >
                    {availableFieldTypes.map((opt) => (
                      <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                        {opt.disabled ? t("configSections.fieldTypeExists", { label: opt.label }) : opt.label}
                      </option>
                    ))}
                  </Select>

                  {newFieldType === "custom" && (
                    <Input
                      type="text"
                      value={newFieldCustomName}
                      onChange={(e) => setNewFieldCustomName(e.target.value)}
                      className="flex-1"
                      placeholder={t("shared.fieldName")}
                      autoFocus
                    />
                  )}

                  <Select
                    value={newFieldEndianness}
                    onChange={(e) => setNewFieldEndianness(e.target.value as "big" | "little")}
                    className="w-16"
                    title={t("configSections.serial.byteOrderTooltip")}
                  >
                    <option value="big">BE</option>
                    <option value="little">LE</option>
                  </Select>

                  <Select
                    value={newFieldFormat}
                    onChange={(e) => setNewFieldFormat(e.target.value as HeaderFieldFormat)}
                    className="w-16"
                  >
                    <option value="hex">{t("common:frameIdFormat.hex")}</option>
                    <option value="decimal">{t("common:frameIdFormat.dec")}</option>
                  </Select>
                </div>

                <div className="flex items-center justify-between">
                  <p className={caption}>
                    {t("configSections.serial.addFieldHint")}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      onClick={resetAddForm}
                      variant="ghost"
                    >
                      {t("common:actions.cancel")}
                    </Button>
                    <Button
                      onClick={handleAddField}
                      disabled={newFieldType === "custom" && !newFieldCustomName.trim()}
                      variant="solid"
                      tone="purple"
                    >
                      {t("common:actions.add")}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {headerFields.length === 0 && !isAddingField && (
              <p className={`${caption} italic`}>
                {t("configSections.serial.noHeaderFields")}
              </p>
            )}
          </div>

          <div className="border-t border-default pt-4 mt-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className={textMedium}>{t("configSections.serial.checksum")}</h3>
                <p className={caption}>{t("configSections.serial.checksumHint")}</p>
              </div>
              {!checksum ? (
                <Button
                  onClick={handleAddChecksum}
                  variant="tonal"
                  tone="purple"
                >
                  <Plus className={iconMd} />
                  {t("checksumDialog.addTitle")}
                </Button>
              ) : (
                <Button
                  onClick={handleRemoveChecksum}
                  variant="ghost"
                  tone="danger"
                >
                  <Trash2 className={iconMd} />
                  {t("common:actions.remove")}
                </Button>
              )}
            </div>

            {checksum && (
              <Card className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-secondary mb-1">
                    {t("checksumDialog.algorithm")}
                  </label>
                  <Select
                    value={checksum.algorithm}
                    onChange={(e) => handleUpdateChecksum({ algorithm: e.target.value as ChecksumAlgorithm })}
                  >
                    {CHECKSUM_ALGORITHMS.map((alg) => (
                      <option key={alg.id} value={alg.id}>
                        {alg.name}
                      </option>
                    ))}
                  </Select>
                  <p className={`mt-0.5 ${caption}`}>
                    {CHECKSUM_ALGORITHMS.find((a) => a.id === checksum.algorithm)?.description}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-secondary mb-1">
                      {t("checksumDialog.startByte")}
                    </label>
                    <Input
                      type="number"
                      value={checksum.start_byte}
                      onChange={(e) => handleUpdateChecksum({ start_byte: parseInt(e.target.value) || 0 })}
                      title={t("configSections.serial.checksumStartTooltip")}
                    />
                    <p className={`mt-0.5 ${caption}`}>
                      {t("configSections.serial.lastByteHint")}
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-secondary mb-1">
                      {t("checksumDialog.byteLength")}
                    </label>
                    <Select
                      value={checksum.byte_length}
                      onChange={(e) => handleUpdateChecksum({ byte_length: parseInt(e.target.value) })}
                    >
                      <option value={1}>{t("configSections.serial.byteCount", { count: 1 })}</option>
                      <option value={2}>{t("configSections.serial.byteCount", { count: 2 })}</option>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-secondary mb-1">
                      {t("configSections.serial.calcStart")}
                    </label>
                    <Input
                      type="number"
                      value={checksum.calc_start_byte}
                      onChange={(e) => handleUpdateChecksum({ calc_start_byte: parseInt(e.target.value) || 0 })}
                      title={t("configSections.serial.calcStartTooltip")}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-secondary mb-1">
                      {t("configSections.serial.calcEnd")}
                    </label>
                    <Input
                      type="number"
                      value={checksum.calc_end_byte ?? ""}
                      onChange={(e) => handleUpdateChecksum({ calc_end_byte: parseInt(e.target.value) || 0 })}
                      title={t("configSections.serial.calcEndTooltip")}
                    />
                    <p className={`mt-0.5 ${caption}`}>
                      {t("configSections.serial.upToChecksumHint")}
                    </p>
                  </div>
                </div>

                {checksum.byte_length === 2 && (
                  <div className={flexRowGap2}>
                    <Checkbox
                      id="checksum-big-endian"
                      checked={checksum.endianness === "big"}
                      onChange={(e) => handleUpdateChecksum({ endianness: e.target.checked ? "big" : "little" })}
                    />
                    <label htmlFor="checksum-big-endian" className="text-sm text-secondary">
                      {t("configSections.serial.checksumBigEndian")}
                    </label>
                  </div>
                )}
              </Card>
            )}

            {!checksum && (
              <p className={`${caption} italic`}>
                {t("configSections.serial.noChecksum")}
              </p>
            )}
          </div>
        </div>
      )}

      {!isExpanded && isConfigured && (
        <div className={`px-4 py-2 ${caption} border-t border-default`}>
          {[
            t("configSections.serial.summaryEncoding", { encoding: encoding?.toUpperCase() ?? t("serialConfig.encodingNotSet") }),
            byteOrder === "big" ? "BE" : "LE",
            headerLength !== undefined && headerLength > 0 && t("configSections.serial.summaryHeader", { bytes: headerLength }),
            headerFields.length > 0 && t("configSections.serial.summaryFields", { count: headerFields.length }),
            hasIdField && t("configSections.serial.summaryIdField"),
            checksum && t("configSections.serial.summaryChecksum", { algorithm: checksum.algorithm.toUpperCase() }),
          ].filter(Boolean).join(" • ")}
        </div>
      )}
    </Card>
  );
}

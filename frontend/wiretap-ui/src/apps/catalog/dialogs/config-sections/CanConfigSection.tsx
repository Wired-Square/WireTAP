// ui/src/apps/catalog/dialogs/config-sections/CanConfigSection.tsx
// CAN protocol configuration section for unified config dialog

import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Network, Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { iconMd, iconXs, flexRowGap2 } from "../../../../styles/spacing";
import { caption, textMedium } from "../../../../styles";
import type { CanHeaderFieldEntry } from "../../../../stores/catalogEditorStore";
import type { HeaderFieldFormat } from "../../types";
import MaskBitPicker from "../../../../components/MaskBitPicker";
import { Button, IconButton } from "../../../../components/Button";
import { Select, Input } from "../../../../components/forms";
import { Card } from "../../../../components/Card";
import { protocolLabel } from "../../../../utils/profileTraits";
import { ConfigSectionHeader } from "./ConfigSectionHeader";
/** Predefined CAN header field types */
type CanFieldType = "source_address" | "custom";

const CAN_FIELD_TYPES: CanFieldType[] = ["source_address", "custom"];

/** Parse a hex string like "0x000000FF" or "255" to a number */
function parseMaskString(maskStr: string): number {
  if (!maskStr) return 0;
  const trimmed = maskStr.trim();
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    return parseInt(trimmed, 16) || 0;
  }
  return parseInt(trimmed, 10) || 0;
}

/** Format a mask number as a hex string like "0x000000FF" */
function formatMaskHex(mask: number, shift: number = 0): string {
  const fullMask = (mask << shift) >>> 0;
  return `0x${fullMask.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Compute byte position info from mask for display */
function computeBitInfo(mask: number, t: TFunction): string {
  if (mask === 0) return t("configSections.noBitsSelected");

  // Find first and last set bit
  let firstBit = -1;
  let lastBit = -1;
  for (let i = 0; i < 32; i++) {
    if ((mask >> i) & 1) {
      if (firstBit === -1) firstBit = i;
      lastBit = i;
    }
  }

  if (firstBit === -1) return t("configSections.noBitsSelected");

  return t("configSections.bitInfo", { count: lastBit - firstBit + 1, first: firstBit });
}

export type CanConfigSectionProps = {
  isConfigured: boolean;
  hasFrames: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onAdd: () => void;
  onRemove: () => void;
  // Config values (only used when configured)
  defaultEndianness: "little" | "big";
  setDefaultEndianness: (endianness: "little" | "big") => void;
  defaultInterval: number | undefined;
  setDefaultInterval: (interval: number | undefined) => void;
  defaultExtended: boolean | undefined;
  setDefaultExtended: (extended: boolean | undefined) => void;
  defaultFd: boolean | undefined;
  setDefaultFd: (fd: boolean | undefined) => void;
  frameIdMask: string;
  setFrameIdMask: (mask: string) => void;
  headerFields: CanHeaderFieldEntry[];
  setHeaderFields: (fields: CanHeaderFieldEntry[]) => void;
};

export default function CanConfigSection({
  isConfigured,
  hasFrames,
  isExpanded,
  onToggleExpanded,
  onAdd,
  onRemove,
  defaultEndianness,
  setDefaultEndianness,
  defaultInterval,
  setDefaultInterval,
  defaultExtended,
  setDefaultExtended,
  defaultFd,
  setDefaultFd,
  frameIdMask,
  setFrameIdMask,
  headerFields,
  setHeaderFields,
}: CanConfigSectionProps) {
  const { t } = useTranslation("catalog");
  // State for inline add form
  const [isAddingField, setIsAddingField] = useState(false);
  const [newFieldType, setNewFieldType] = useState<CanFieldType>("source_address");
  const [newFieldCustomName, setNewFieldCustomName] = useState("");
  const [newFieldFormat, setNewFieldFormat] = useState<HeaderFieldFormat>("hex");

  // Track which existing fields have their bit picker expanded
  const [expandedFieldPickers, setExpandedFieldPickers] = useState<Record<number, boolean>>({});

  // State for frame ID mask bit picker
  const [showFrameIdMaskPicker, setShowFrameIdMaskPicker] = useState(false);
  const [useExtendedId, setUseExtendedId] = useState(true);

  // Check if source_address field already exists
  const hasSourceAddressField = useMemo(
    () => headerFields.some((f) => f.name.toLowerCase() === "source_address"),
    [headerFields]
  );

  const toggleFieldPicker = useCallback((index: number) => {
    setExpandedFieldPickers((prev) => ({
      ...prev,
      [index]: !prev[index],
    }));
  }, []);

  const resetAddForm = () => {
    setNewFieldType("source_address");
    setNewFieldCustomName("");
    setNewFieldFormat("hex");
    setIsAddingField(false);
  };

  const handleFrameIdMaskPickerChange = useCallback((mask: number, shift: number) => {
    const fullMask = (mask << shift) >>> 0;
    setFrameIdMask(`0x${fullMask.toString(16).toUpperCase().padStart(8, '0')}`);
  }, [setFrameIdMask]);

  const handleFieldMaskChange = useCallback((index: number, mask: number, shift: number) => {
    const fullMask = (mask << shift) >>> 0;
    handleUpdateField(index, { mask: formatMaskHex(fullMask, 0), shift });
  }, []);

  const handleAddField = () => {
    const name = newFieldType === "custom"
      ? newFieldCustomName.trim()
      : newFieldType;

    if (!name) return;

    // Default mask: 0xFF for source_address (bits 0-7), full mask for custom
    const defaultMask = newFieldType === "source_address" ? 0xFF : 0x1FFFFFFF;

    const newField: CanHeaderFieldEntry = {
      name,
      mask: formatMaskHex(defaultMask, 0),
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

  const handleUpdateField = (index: number, updates: Partial<CanHeaderFieldEntry>) => {
    setHeaderFields(
      headerFields.map((field, i) =>
        i === index ? { ...field, ...updates } : field
      )
    );
  };

  // Filter field type options - disable source_address if already exists
  const availableFieldTypes = CAN_FIELD_TYPES.map((value) => ({
    value,
    label: t(`configSections.fieldTypes.${value}`),
    disabled: value === "source_address" && hasSourceAddressField,
  }));

  const showWarning = hasFrames && !isConfigured;

  return (
    <Card padding="none" className="overflow-hidden">
      <ConfigSectionHeader
        label={protocolLabel("can")}
        icon={<Network className={iconMd} />}
        tone="success"
        isConfigured={isConfigured}
        showWarning={showWarning}
        isExpanded={isExpanded}
        onToggleExpanded={onToggleExpanded}
        onAdd={onAdd}
        onRemove={onRemove}
      />

      {isExpanded && isConfigured && (
        <div className="p-4 space-y-4 border-t border-default">
          <div>
            <label className={`block ${textMedium} mb-2`}>
              {t("canConfig.defaultByteOrder")} <span className="text-danger">*</span>
            </label>
            <Select
              value={defaultEndianness}
              onChange={(e) => setDefaultEndianness(e.target.value as "little" | "big")}
              size="lg"
            >
              <option value="little">{t("shared.littleEndian")}</option>
              <option value="big">{t("shared.bigEndian")}</option>
            </Select>
            <p className={`mt-1 ${caption}`}>
              {t("configSections.can.byteOrderHint")}
            </p>
          </div>

          <div>
            <label className={`block ${textMedium} mb-2`}>
              {t("configSections.can.interval")} <span className="text-muted text-xs font-normal">{t("common:forms.optional")}</span>
            </label>
            <Input
              type="number"
              min={0}
              value={defaultInterval ?? ""}
              onChange={(e) => {
                const val = e.target.value;
                setDefaultInterval(val === "" ? undefined : parseInt(val));
              }}
              size="lg"
              placeholder="1000"
            />
            <p className={`mt-1 ${caption}`}>
              {t("configSections.can.intervalHint")}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={`block ${textMedium} mb-2`}>
                {t("canConfig.defaultExtendedId")} <span className="text-muted text-xs font-normal">{t("common:forms.optional")}</span>
              </label>
              <Select
                value={defaultExtended === undefined ? "auto" : defaultExtended ? "true" : "false"}
                onChange={(e) => {
                  const val = e.target.value;
                  setDefaultExtended(val === "auto" ? undefined : val === "true");
                }}
                size="lg"
              >
                <option value="auto">{t("configSections.can.extendedAuto")}</option>
                <option value="false">{t("configSections.can.extendedNo")}</option>
                <option value="true">{t("configSections.can.extendedYes")}</option>
              </Select>
              <p className={`mt-1 ${caption}`}>
                {t("configSections.can.extendedHint")}
              </p>
            </div>

            <div>
              <label className={`block ${textMedium} mb-2`}>
                {t("canConfig.defaultCanFd")} <span className="text-muted text-xs font-normal">{t("common:forms.optional")}</span>
              </label>
              <Select
                value={defaultFd === undefined ? "auto" : defaultFd ? "true" : "false"}
                onChange={(e) => {
                  const val = e.target.value;
                  setDefaultFd(val === "auto" ? undefined : val === "true");
                }}
                size="lg"
              >
                <option value="auto">{t("configSections.can.fdAuto")}</option>
                <option value="false">{t("canConfig.noClassic")}</option>
                <option value="true">{t("configSections.can.fdYes")}</option>
              </Select>
              <p className={`mt-1 ${caption}`}>
                {t("configSections.can.fdHint")}
              </p>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={textMedium}>
                {t("configSections.can.idMask")} <span className="text-muted text-xs font-normal">{t("configSections.can.optionalHex")}</span>
              </label>
              <Button
                onClick={() => setShowFrameIdMaskPicker(!showFrameIdMaskPicker)}
                variant="link"
                tone="success"
                className="text-xs"
              >
                {showFrameIdMaskPicker ? <ChevronDown className={iconXs} /> : <ChevronRight className={iconXs} />}
                {showFrameIdMaskPicker ? t("shared.hideBitPicker") : t("shared.showBitPicker")}
              </Button>
            </div>
            <div className={flexRowGap2}>
              <Input
                type="text"
                value={frameIdMask}
                onChange={(e) => setFrameIdMask(e.target.value)}
                size="lg"
                mono
                className="flex-1"
                placeholder="0x1FFFFF00"
              />
              <div className="flex items-center gap-1">
                <span className={caption}>{t("configSections.can.idType")}</span>
                <Select
                  value={useExtendedId ? "extended" : "standard"}
                  onChange={(e) => setUseExtendedId(e.target.value === "extended")}
                  size="lg"
                  className="w-24"
                  title={t("configSections.can.idTypeTooltip")}
                >
                  <option value="extended">29-bit</option>
                  <option value="standard">11-bit</option>
                </Select>
              </div>
            </div>
            {showFrameIdMaskPicker && (
              <Card className="mt-3">
                <MaskBitPicker
                  mask={parseMaskString(frameIdMask)}
                  shift={0}
                  onMaskChange={handleFrameIdMaskPickerChange}
                  numBytes={4}
                  activeBits={useExtendedId ? 29 : 11}
                />
              </Card>
            )}
            <p className={`mt-1 ${caption}`}>
              {t("configSections.can.idMaskHint")}
            </p>
          </div>

          <div className="border-t border-default pt-4 mt-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className={textMedium}>{t("configSections.headerFields")}</h3>
                <p className={caption}>{t("configSections.can.headerFieldsHint")}</p>
              </div>
              {!isAddingField && (
                <Button
                  onClick={() => setIsAddingField(true)}
                  variant="tonal"
                  tone="success"
                >
                  <Plus className={iconMd} />
                  {t("shared.addField")}
                </Button>
              )}
            </div>

            {headerFields.length > 0 && (
              <div className="space-y-2 mb-3">
                {headerFields.map((field, index) => {
                  const isFieldExpanded = expandedFieldPickers[index] ?? false;
                  const fieldMask = parseMaskString(field.mask);
                  const fieldShift = field.shift ?? 0;
                  // For the bit picker, we need the unshifted mask
                  // If shift is stored, the mask was already stored as full mask, so we need to unshift
                  const unshiftedMask = fieldShift > 0 ? (fieldMask >>> fieldShift) : fieldMask;

                  return (
                    <div key={index} className="space-y-2">
                      <Card padding="sm" className="flex items-center gap-2">
                        <IconButton
                          onClick={() => toggleFieldPicker(index)}
                          size="sm"
                          title={isFieldExpanded ? t("shared.hideBitPicker") : t("shared.showBitPicker")}
                        >
                          {isFieldExpanded ? (
                            <ChevronDown className={iconMd} />
                          ) : (
                            <ChevronRight className={iconMd} />
                          )}
                        </IconButton>

                        <span className="w-28 font-medium text-sm text-primary truncate">
                          {field.name}
                        </span>

                        <Input
                          type="text"
                          value={field.mask}
                          onChange={(e) => handleUpdateField(index, { mask: e.target.value })}
                          size="xs"
                          mono
                          className="w-28"
                          title={t("configSections.can.maskTooltip")}
                        />

                        <div className="flex items-center gap-1">
                          <span className={caption}>&gt;&gt;</span>
                          <Input
                            type="number"
                            min={0}
                            max={31}
                            value={fieldShift}
                            onChange={(e) => handleUpdateField(index, { shift: parseInt(e.target.value) || 0 })}
                            size="xs"
                            mono
                            className="w-12 text-center"
                            title={t("configSections.can.shiftTooltip")}
                          />
                        </div>

                        <span className={caption}>
                          ({computeBitInfo(fieldMask, t)})
                        </span>

                        <div className="flex-1" />

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

                      {isFieldExpanded && (
                        <Card className="ml-8">
                          <MaskBitPicker
                            mask={unshiftedMask}
                            shift={fieldShift}
                            onMaskChange={(mask, shift) => handleFieldMaskChange(index, mask, shift)}
                            numBytes={4}
                            activeBits={useExtendedId ? 29 : 11}
                          />
                        </Card>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {isAddingField && (
              <div className="p-3 bg-success rounded-lg border border-success">
                <div className="flex items-center gap-2 mb-3">
                  <Select
                    value={newFieldType}
                    onChange={(e) => setNewFieldType(e.target.value as CanFieldType)}
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
                    {t("configSections.can.addFieldHint")}
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
                      tone="success"
                    >
                      {t("common:actions.add")}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {headerFields.length === 0 && !isAddingField && (
              <p className={`${caption} italic`}>
                {t("configSections.can.noHeaderFields")}
              </p>
            )}
          </div>
        </div>
      )}

      {!isExpanded && isConfigured && (
        <div className={`px-4 py-2 ${caption} border-t border-default`}>
          {[
            t("configSections.can.summaryByteOrder", { order: defaultEndianness }),
            defaultInterval !== undefined && t("configSections.can.summaryInterval", { ms: defaultInterval }),
            defaultExtended !== undefined && t(defaultExtended ? "configSections.can.summaryExtendedYes" : "configSections.can.summaryExtendedNo"),
            defaultFd !== undefined && t(defaultFd ? "configSections.can.summaryFdYes" : "configSections.can.summaryFdNo"),
            frameIdMask && t("configSections.can.summaryMask", { mask: frameIdMask }),
            headerFields.length > 0 && t("configSections.can.summaryHeaderFields", { count: headerFields.length }),
          ].filter(Boolean).join(" • ")}
        </div>
      )}
    </Card>
  );
}

// ui/src/apps/catalog/views/CANFrameEditView.tsx

import { useTranslation } from "react-i18next";
import type { CanidFields } from "../types";
import { textMedium } from "../../../styles";
import { SecondaryButton, PrimaryButton, Input, Select, Textarea } from "../../../components/forms";

export type CANFrameEditViewProps = {
  title?: string;
  subtitle?: string;

  idFields: CanidFields;
  setIdFields: (next: CanidFields) => void;

  availablePeers: string[];

  primaryActionLabel?: string;
  onCancel: () => void;
  onSave: () => void;

  disableSave?: boolean;
};

export default function CANFrameEditView({
  title,
  subtitle,
  idFields,
  setIdFields,
  availablePeers,
  primaryActionLabel,
  onCancel,
  onSave,
  disableSave,
}: CANFrameEditViewProps) {
  const { t } = useTranslation("catalog");
  const resolvedTitle = title ?? t("canFrameEditView.addTitle");
  const resolvedSubtitle = subtitle ?? t("canFrameEditView.addSubtitle");
  const resolvedAction = primaryActionLabel ?? t("canFrameEditView.addButton");
  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-primary mb-2">{resolvedTitle}</h2>
        <p className="text-sm text-muted">{resolvedSubtitle}</p>
      </div>

      <div className="space-y-4">
        {/* ID - Required */}
        <div>
          <label className={`block ${textMedium} mb-2`}>
            {t("canFrameEditView.id")} <span className="text-danger">{t("canFrameEditView.required")}</span>
          </label>
          <Input
            type="text"
            value={idFields.id}
            onChange={(e) => setIdFields({ ...idFields, id: e.target.value })}
            size="lg"
            mono
            placeholder={t("canFrameEditView.idPlaceholder")}
          />
        </div>

        {/* Length (DLC) - Required */}
        <div>
          <label className={`block ${textMedium} mb-2`}>
            {t("canFrameEditView.lengthDlc")} <span className="text-danger">{t("canFrameEditView.required")}</span>
          </label>
          <Input
            type="number"
            min="0"
            max="64"
            value={idFields.length}
            onChange={(e) => setIdFields({ ...idFields, length: parseInt(e.target.value) || 0 })}
            size="lg"
          />
        </div>

        {/* Transmitter (Peer) - Optional */}
        <div>
          <label className={`block ${textMedium} mb-2`}>
            {t("canFrameEditView.transmitter")}
          </label>
          <Select
            value={idFields.transmitter || ""}
            onChange={(e) => setIdFields({ ...idFields, transmitter: e.target.value || undefined })}
            size="lg"
          >
            <option value="">{t("canFrameEditView.transmitterNone")}</option>
            {availablePeers.map((peer) => (
              <option key={peer} value={peer}>
                {peer}
              </option>
            ))}
          </Select>
        </div>

        {/* Interval (ms) - Optional */}
        <div>
          <label className={`block ${textMedium} mb-2`}>
            {t("canFrameEditView.interval")}
          </label>
          <Input
            type="number"
            min="0"
            value={idFields.interval !== undefined ? idFields.interval : ""}
            onChange={(e) =>
              setIdFields({
                ...idFields,
                interval: e.target.value ? parseInt(e.target.value) : undefined,
              })
            }
            size="lg"
            placeholder={t("canFrameEditView.intervalPlaceholder")}
          />
        </div>

        {/* Notes - Optional */}
        <div>
          <label className={`block ${textMedium} mb-2`}>
            {t("canFrameEditView.notes")}
          </label>
          <Textarea
            rows={4}
            value={
              Array.isArray(idFields.notes)
                ? idFields.notes.join("\n")
                : idFields.notes || ""
            }
            onChange={(e) => {
              const value = e.target.value;
              if (!value) {
                setIdFields({ ...idFields, notes: undefined });
              } else {
                const lines = value.split("\n");
                setIdFields({
                  ...idFields,
                  notes: lines.length === 1 ? lines[0] : lines,
                });
              }
            }}
            size="lg"
            mono
            placeholder={t("canFrameEditView.notesPlaceholder")}
          />
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <SecondaryButton
            onClick={onCancel}
          >
            {t("canFrameEditView.cancel")}
          </SecondaryButton>
          <PrimaryButton
            onClick={onSave}
            disabled={disableSave || !idFields.id}
          >
            {resolvedAction}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

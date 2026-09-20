// src/dialogs/EventDialog.tsx
//
// Add or edit one event. The field shows seconds, but an untouched time keeps
// the microseconds it opened with — a frame's timestamp survives a note edit.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Dialog, { DialogBody, DialogFooter } from "../components/Dialog";
import { FormField, Input, PrimaryButton, SecondaryButton, Textarea } from "../components/forms";
import { helpText } from "../styles/typography";
import { microsToDatetimeLocal } from "../utils/timeFormat";
import type { EventDraft } from "../api/captureEvents";
import type { EventDialogDraft } from "../hooks/useSessionEvents";

type Props = {
  isOpen: boolean;
  /** The values the form opens with — for an add, the time to mark. */
  initial: EventDialogDraft | null;
  onClose: () => void;
  onSave: (draft: EventDraft) => void;
};

export default function EventDialog({ isOpen, initial, onClose, onSave }: Props) {
  const { t } = useTranslation("events");
  const [timestampUs, setTimestampUs] = useState(0);
  const [timeText, setTimeText] = useState("");
  const [durationText, setDurationText] = useState("0");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!isOpen || !initial) return;
    setTimestampUs(initial.timestampUs);
    setTimeText(microsToDatetimeLocal(initial.timestampUs));
    setDurationText(String(initial.durationUs / 1_000_000));
    setNote(initial.note);
  }, [isOpen, initial]);

  const durationSeconds = Number(durationText);
  const valid = timestampUs > 0 && Number.isFinite(durationSeconds) && durationSeconds >= 0;

  const handleTimeChange = (text: string) => {
    setTimeText(text);
    const ms = new Date(text).getTime();
    if (!Number.isNaN(ms)) setTimestampUs(ms * 1000);
  };

  const handleSave = () => {
    if (!valid) return;
    onSave({ timestampUs, durationUs: Math.round(durationSeconds * 1_000_000), note: note.trim() });
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={initial?.id ? t("dialog.editTitle") : t("dialog.addTitle")}>
      <DialogBody className="space-y-3">
        <FormField label={t("dialog.time")}>
          <Input size="lg" type="datetime-local" step={1} value={timeText} onChange={(e) => handleTimeChange(e.target.value)} />
        </FormField>
        <FormField label={t("dialog.duration")}>
          <Input size="lg" type="number" min={0} step={0.001} value={durationText} onChange={(e) => setDurationText(e.target.value)} />
          <p className={`${helpText} mt-1`}>{t("dialog.durationHint")}</p>
        </FormField>
        <FormField label={t("dialog.note")}>
          <Textarea
            size="lg"
            rows={3}
            className="resize-y"
            value={note}
            placeholder={t("dialog.notePlaceholder")}
            onChange={(e) => setNote(e.target.value)}
            autoFocus
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onClose}>{t("common:actions.cancel")}</SecondaryButton>
        <PrimaryButton onClick={handleSave} disabled={!valid}>{t("dialog.save")}</PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}

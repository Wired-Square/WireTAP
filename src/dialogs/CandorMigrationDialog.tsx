// ui/src/dialogs/CandorMigrationDialog.tsx
//
// Shown on startup when old CANdor configuration data is detected.
// Offers three choices: migrate, delete, or skip.

import { useState } from "react";
import { ArrowRightLeft, Trash2, X } from "lucide-react";
import Dialog from "../components/Dialog";
import { PrimaryButton, SecondaryButton, DangerButton } from "../components/forms";
import type { CandorMigrationInfo } from "../api/settings";
import { runCandorMigration, deleteCandorData } from "../api/settings";
import {
  h3,
  bodyDefault,
  paddingDialog,
  borderDefault,
  roundedDefault,
  gapDefault,
  textMuted,
} from "../styles";
import { iconMd } from "../styles/spacing";

type Props = {
  open: boolean;
  info: CandorMigrationInfo;
  onComplete: () => void;
};

export default function CandorMigrationDialog({ open, info, onComplete }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleMigrate = async () => {
    setBusy(true);
    setError(null);
    try {
      await runCandorMigration();
      // Reload settings so the UI picks up migrated IO profiles
      window.location.reload();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteCandorData();
      onComplete();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog isOpen={open}>
      <div className={`${paddingDialog} border ${borderDefault} ${roundedDefault}`}>
        <h3 className={`${h3} mb-3`}>CANdor Data Found</h3>

        <p className={`${bodyDefault} mb-4`}>
          Configuration from the previous CANdor installation was found. Would you like to
          migrate it to WireTAP?
        </p>

        {info.io_profile_count > 0 && (
          <div className={`mb-4 px-3 py-2 rounded border ${borderDefault} text-xs`}>
            <p className={`font-medium mb-1 ${textMuted}`}>
              {info.io_profile_count} IO profile{info.io_profile_count !== 1 ? "s" : ""}
            </p>
            <ul className={`${textMuted} space-y-0.5 ml-3 list-disc`}>
              {info.io_profile_names.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        )}

        {info.has_ui_state && (
          <p className={`text-xs ${textMuted} mb-4`}>
            Includes saved layouts, selection sets, and favourites.
          </p>
        )}

        {error && (
          <p className="text-xs text-red-500 mb-4">{error}</p>
        )}

        <div className={`flex justify-end ${gapDefault}`}>
          <SecondaryButton onClick={onComplete} disabled={busy}>
            <span className="flex items-center gap-1.5">
              <X className={iconMd} />
              Skip
            </span>
          </SecondaryButton>
          <DangerButton onClick={handleDelete} disabled={busy}>
            <span className="flex items-center gap-1.5">
              <Trash2 className={iconMd} />
              Delete
            </span>
          </DangerButton>
          <PrimaryButton onClick={handleMigrate} disabled={busy}>
            <span className="flex items-center gap-1.5">
              <ArrowRightLeft className={iconMd} />
              {busy ? "Migrating..." : "Migrate"}
            </span>
          </PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}

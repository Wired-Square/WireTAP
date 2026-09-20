// ui/src/dialogs/SendCaptureToBackendDialog.tsx
//
// Upload a local SQLite capture to a WireTAP backend capture database via
// the backend HTTP API. Lets the user pick a target wiretap profile and an
// existing or new database, then streams the frames with a progress bar.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { UploadCloud } from "lucide-react";
import Dialog, { DialogBody, DialogFooter } from "../components/Dialog";
import Input from "../components/forms/Input";
import Select from "../components/forms/Select";
import { useAllIOProfiles } from "../hooks/useAllIOProfiles";
import {
  apiCreateDatabase,
  apiImportCapture,
  apiListDatabases,
  type ApiDatabase,
  type CaptureUploadProgress,
} from "../api/backendApi";
import { labelDefault, helpText, textPrimary } from "../styles";
import { SecondaryButton, PrimaryButton, Checkbox } from "../components/forms";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  captureId: string;
  captureName: string;
}

type Phase = "configure" | "uploading" | "done" | "error";

export default function SendCaptureToBackendDialog({
  isOpen,
  onClose,
  captureId,
  captureName,
}: Props) {
  const { t } = useTranslation("common");
  const allIOProfiles = useAllIOProfiles();

  const wiretapProfiles = useMemo(
    () => allIOProfiles.filter((p) => p.kind === "wiretap"),
    [allIOProfiles],
  );

  const [profileId, setProfileId] = useState("");
  const [databases, setDatabases] = useState<ApiDatabase[]>([]);
  const [database, setDatabase] = useState("");
  const [newDatabase, setNewDatabase] = useState(false);
  const [phase, setPhase] = useState<Phase>("configure");
  const [progress, setProgress] = useState<CaptureUploadProgress | null>(null);
  const [error, setError] = useState("");
  const [imported, setImported] = useState(0);

  // Default to the first wiretap profile when opened
  useEffect(() => {
    if (isOpen && !profileId && wiretapProfiles.length) {
      setProfileId(wiretapProfiles[0].id);
    }
  }, [isOpen, profileId, wiretapProfiles]);

  // Load the database list whenever the target profile changes
  useEffect(() => {
    if (!profileId) return;
    let live = true;
    apiListDatabases(profileId)
      .then((dbs) => {
        if (!live) return;
        setDatabases(dbs);
        setDatabase((prev) => prev || dbs[0]?.name || "");
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [profileId]);

  // Subscribe to upload progress while uploading
  useEffect(() => {
    if (phase !== "uploading") return;
    const unlisten = listen<CaptureUploadProgress>("capture-upload-progress", (e) => {
      if (e.payload.capture_id === captureId) setProgress(e.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [phase, captureId]);

  const reset = () => {
    setPhase("configure");
    setProgress(null);
    setError("");
    setImported(0);
  };

  const handleClose = () => {
    if (phase === "uploading") return; // don't close mid-upload
    reset();
    onClose();
  };

  const startUpload = async () => {
    setError("");
    setPhase("uploading");
    try {
      if (newDatabase && database) {
        await apiCreateDatabase(profileId, database).catch(() => {
          // create=true on import also auto-creates; ignore "already exists"
        });
      }
      const count = await apiImportCapture(profileId, captureId, database, true);
      setImported(count);
      setPhase("done");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  };

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.sent / progress.total) * 100))
      : 0;

  const dbNameValid = /^[a-z][a-z0-9_]*$/.test(database);

  return (
    <Dialog
      isOpen={isOpen}
      onClose={handleClose}
      title={t("sendToBackend.title")}
      icon={<UploadCloud className="text-accent-primary" />}
    >
      <DialogBody className="space-y-4">
        <p className={helpText}>{t("sendToBackend.description", { name: captureName })}</p>

        {wiretapProfiles.length === 0 ? (
          <p className="text-warning text-sm">
            {t("sendToBackend.noProfiles")}
          </p>
        ) : phase === "configure" || phase === "error" ? (
          <>
            <div className="space-y-2">
              <label className={labelDefault}>{t("sendToBackend.profile")}</label>
              <Select size="lg" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                {wiretapProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>

            <div className="space-y-2">
              <label className={labelDefault}>{t("sendToBackend.database")}</label>
              {newDatabase ? (
                <Input
                  size="lg"
                  value={database}
                  onChange={(e) => setDatabase(e.target.value.toLowerCase())}
                  placeholder="vehicle_2"
                />
              ) : (
                <Select size="lg" value={database} onChange={(e) => setDatabase(e.target.value)}>
                  {databases.map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.name}
                    </option>
                  ))}
                  {databases.length === 0 && <option value="">—</option>}
                </Select>
              )}
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={newDatabase}
                  onChange={(e) => {
                    setNewDatabase(e.target.checked);
                    if (e.target.checked) setDatabase("");
                  }}
                />
                <span className={helpText}>{t("sendToBackend.newDatabase")}</span>
              </label>
              {newDatabase && database && !dbNameValid && (
                <p className="text-danger text-xs">
                  {t("sendToBackend.invalidName")}
                </p>
              )}
            </div>

            {error && <p className="text-danger text-sm">{error}</p>}
          </>
        ) : phase === "uploading" ? (
          <div className="space-y-3">
            <div className="h-2 rounded-full bg-tertiary overflow-hidden">
              <div
                className="h-full bg-accent-primary transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className={helpText}>
              {progress
                ? t("sendToBackend.progress", {
                    sent: progress.sent.toLocaleString(),
                    total: progress.total.toLocaleString(),
                  })
                : t("sendToBackend.starting")}
            </p>
          </div>
        ) : (
          <p className={textPrimary}>
            {t("sendToBackend.done", { count: imported.toLocaleString(), database })}
          </p>
        )}
      </DialogBody>
      {phase === "configure" || phase === "error" ? (
        <DialogFooter>
          <SecondaryButton onClick={handleClose}>{t("actions.cancel")}</SecondaryButton>
          <PrimaryButton
            disabled={!profileId || !database || (newDatabase && !dbNameValid)}
            onClick={startUpload}
          >
            {t("sendToBackend.upload")}
          </PrimaryButton>
        </DialogFooter>
      ) : phase === "done" ? (
        <DialogFooter>
          <PrimaryButton onClick={handleClose}>{t("actions.close")}</PrimaryButton>
        </DialogFooter>
      ) : null}
    </Dialog>
  );
}

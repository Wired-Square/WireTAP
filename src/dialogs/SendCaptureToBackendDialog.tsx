// ui/src/dialogs/SendCaptureToBackendDialog.tsx
//
// Upload a local SQLite capture to a WireTAP backend capture database via
// the backend HTTP API. Lets the user pick a target wiretap profile and an
// existing or new database, then streams the frames with a progress bar.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { UploadCloud } from "lucide-react";
import Dialog from "../components/Dialog";
import Input from "../components/forms/Input";
import Select from "../components/forms/Select";
import { useSettings } from "../hooks/useSettings";
import {
  apiCreateDatabase,
  apiImportCapture,
  apiListDatabases,
  type ApiDatabase,
  type CaptureUploadProgress,
} from "../api/backendApi";
import { primaryButtonBase, secondaryButton } from "../styles/buttonStyles";
import { labelDefault, helpText, textPrimary } from "../styles";

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
  const { settings } = useSettings();

  const wiretapProfiles = useMemo(
    () => (settings?.io_profiles ?? []).filter((p) => p.kind === "wiretap"),
    [settings?.io_profiles],
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
    <Dialog isOpen={isOpen} onBackdropClick={handleClose} maxWidth="max-w-md">
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <UploadCloud className="w-5 h-5 text-[color:var(--accent)]" />
          <h2 className={`text-lg font-semibold ${textPrimary}`}>
            {t("sendToBackend.title")}
          </h2>
        </div>
        <p className={helpText}>{t("sendToBackend.description", { name: captureName })}</p>

        {wiretapProfiles.length === 0 ? (
          <p className="text-[color:var(--status-warning-text)] text-sm">
            {t("sendToBackend.noProfiles")}
          </p>
        ) : phase === "configure" || phase === "error" ? (
          <>
            <div className="space-y-2">
              <label className={labelDefault}>{t("sendToBackend.profile")}</label>
              <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
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
                  value={database}
                  onChange={(e) => setDatabase(e.target.value.toLowerCase())}
                  placeholder="vehicle_2"
                />
              ) : (
                <Select value={database} onChange={(e) => setDatabase(e.target.value)}>
                  {databases.map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.name}
                    </option>
                  ))}
                  {databases.length === 0 && <option value="">—</option>}
                </Select>
              )}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newDatabase}
                  onChange={(e) => {
                    setNewDatabase(e.target.checked);
                    if (e.target.checked) setDatabase("");
                  }}
                />
                <span className={helpText}>{t("sendToBackend.newDatabase")}</span>
              </label>
              {newDatabase && database && !dbNameValid && (
                <p className="text-[color:var(--status-danger-text)] text-xs">
                  {t("sendToBackend.invalidName")}
                </p>
              )}
            </div>

            {error && <p className="text-[color:var(--status-danger-text)] text-sm">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button className={secondaryButton} onClick={handleClose}>
                {t("actions.cancel")}
              </button>
              <button
                className={primaryButtonBase}
                disabled={!profileId || !database || (newDatabase && !dbNameValid)}
                onClick={startUpload}
              >
                {t("sendToBackend.upload")}
              </button>
            </div>
          </>
        ) : phase === "uploading" ? (
          <div className="space-y-3">
            <div className="h-2 rounded-full bg-[var(--bg-surface-2,#222)] overflow-hidden">
              <div
                className="h-full bg-[color:var(--accent)] transition-all"
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
          <div className="space-y-3">
            <p className={textPrimary}>
              {t("sendToBackend.done", { count: imported.toLocaleString(), database })}
            </p>
            <div className="flex justify-end">
              <button className={primaryButtonBase} onClick={handleClose}>
                {t("actions.close")}
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

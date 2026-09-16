// ui/src/dialogs/io-source-picker/DeviceEditor.tsx
//
// Create a device without leaving the source picker.
//
// It connects as an *ephemeral* profile — registered with the backend for this
// run, never written to settings.json — unless "Save to Settings" is ticked.
//
// Creation only. Changing an existing device is `DeviceSettingsDialog`, which
// the pencil on a device row opens: that path is app-agnostic and the backend
// reconnects the live source itself, keeping the session id.

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { iconMd } from "../../styles/spacing";
import { borderDefault, caption, textMedium, alertWarning } from "../../styles";
import {
  Input,
  Select,
  FormField,
  CheckboxField,
  PrimaryButton,
  SecondaryButton,
} from "../../components/forms";
import IOConnectionFields from "../../components/io/IOConnectionFields";
import { useConnectionProbe, usePlatformInfo } from "../../components/io/useConnectionProbe";
import { applyConnectionDefaults, validateProfileForm } from "../../settings/ioProfileForm";
import { getTraitsForKind } from "../../utils/profileTraits";
import type { IOProfile, ConnectionFieldValue, ProfileKindId } from "../../hooks/useSettings";

export interface DeviceEditorProps {
  /** Names already taken by existing devices, for the duplicate check. */
  takenNames: Set<string>;
  onCancel: () => void;
  /** Connect using an ad-hoc device, registered for this run only. */
  onUseAdHoc: (profile: IOProfile) => Promise<void>;
  /** Persist the device to Settings, then connect. */
  onSave: (profile: IOProfile) => Promise<void>;
}

/** A readable default name, so an ad-hoc device needs no typing to connect. */
function autoName(profile: IOProfile, kindLabel: string): string {
  const conn = profile.connection as Record<string, unknown>;
  const detail = conn.port || conn.host || conn.interface || conn.device_id || conn.url;
  return detail ? `${kindLabel} · ${String(detail)}` : kindLabel;
}

export default function DeviceEditor({
  takenNames,
  onCancel,
  onUseAdHoc,
  onSave,
}: DeviceEditorProps) {
  const { t } = useTranslation("dialogs");
  const platform = usePlatformInfo();

  // `as IOProfile` throughout: the discriminated union does not survive a
  // spread, so kind/connection correlation has to be reasserted — the same
  // pattern the Settings profile form uses.
  const [draft, setDraft] = useState<IOProfile>(
    () => ({ id: "", name: "", kind: "slcan", connection: {} }) as IOProfile,
  );
  // Null until the user types: the name then tracks the kind and connection, so
  // a device arrives named after what it is with no typing required.
  const [customName, setCustomName] = useState<string | null>(null);
  const [saveToSettings, setSaveToSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const kindLabel = t(`settings:ioProfileDialog.kinds.${draft.kind}`);
  const effectiveName = customName ?? autoName(draft, kindLabel);

  // The editor opens from the Devices tab, and SourceList files a device by
  // `isRealtimeProfile`. Offering a recorded kind here would create a device
  // that immediately disappears into the Captures tab.
  const creatableKinds = useMemo(
    () =>
      platform.availableKinds.filter(
        (kind) => getTraitsForKind(kind)?.temporalMode === "realtime",
      ),
    [platform.availableKinds],
  );

  const updateConnectionField = useCallback((key: string, value: ConnectionFieldValue) => {
    setDraft((prev) => ({
      ...prev,
      connection: { ...prev.connection, [key]: value },
    }) as IOProfile);
  }, []);

  const probe = useConnectionProbe({
    profile: draft,
    active: true,
    platform,
    // GVRET probes by profile id, and this device has none until it is created.
    probeProfileId: null,
    onUpdateConnectionField: updateConnectionField as (key: string, value: unknown) => void,
    probeFailedText: t("ioSourcePicker.deviceEditor.probeFailed"),
  });

  const commit = useCallback(
    async (persist: boolean) => {
      // The draft with its name and per-kind defaults settled.
      const resolved = applyConnectionDefaults({ ...draft, name: effectiveName } as IOProfile);
      const invalid = validateProfileForm(resolved, takenNames);
      if (invalid) {
        setError(t(`ioSourcePicker.deviceEditor.errors.${invalid}`));
        return;
      }
      setError(null);
      setBusy(true);
      try {
        await (persist ? onSave(resolved) : onUseAdHoc(resolved));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [draft, effectiveName, takenNames, onSave, onUseAdHoc, t],
  );

  return (
    <div className={`border-t ${borderDefault}`}>
      <div className="px-4 py-3 space-y-4">
        <div>
          <h3 className={textMedium}>{t("ioSourcePicker.deviceEditor.newTitle")}</h3>
          <p className={caption}>{t("ioSourcePicker.deviceEditor.newHint")}</p>
        </div>

        <FormField label={t("ioSourcePicker.deviceEditor.kind")} variant="default">
          <Select
            variant="default"
            value={draft.kind}
            onChange={(e) =>
              setDraft(
                (prev) =>
                  ({
                    ...prev,
                    kind: e.target.value as ProfileKindId,
                    // Connection fields are kind-specific; carrying them over
                    // would leave a stale host on a serial device.
                    connection: {},
                  }) as IOProfile,
              )
            }
          >
            {creatableKinds.map((kind) => (
              <option key={kind} value={kind}>
                {t(`settings:ioProfileDialog.kinds.${kind}`)}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField label={t("ioSourcePicker.deviceEditor.name")} variant="default">
          <Input
            variant="default"
            value={effectiveName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder={t("ioSourcePicker.deviceEditor.namePlaceholder")}
          />
        </FormField>

        <IOConnectionFields
          profile={draft}
          onUpdateConnectionField={updateConnectionField}
          probe={probe}
          platform={platform}
          // A device that does not exist yet cannot be probed by id.
          canProbeByProfileId={false}
        />

        {error && (
          <div className={`${alertWarning} flex items-center gap-2`}>
            <AlertCircle className={`${iconMd} flex-shrink-0`} />
            <span className="text-sm text-[color:var(--text-amber)]">{error}</span>
          </div>
        )}
      </div>

      <div
        className={`px-4 py-3 border-t ${borderDefault} flex items-center justify-between gap-3`}
      >
        <CheckboxField
          checked={saveToSettings}
          onChange={setSaveToSettings}
          label={t("ioSourcePicker.deviceEditor.saveToSettings")}
        />

        <div className="flex items-center gap-2">
          <SecondaryButton onClick={onCancel} disabled={busy}>
            {t("ioSourcePicker.deviceEditor.cancel")}
          </SecondaryButton>

          <PrimaryButton onClick={() => void commit(saveToSettings)} disabled={busy}>
            {t("ioSourcePicker.deviceEditor.connect")}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

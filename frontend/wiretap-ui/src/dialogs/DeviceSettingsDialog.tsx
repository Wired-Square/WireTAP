// src/dialogs/DeviceSettingsDialog.tsx
//
// Change a device's connection parameters — bitrate, baud rate, 8N1, host, port
// — from wherever the user is, including while it is streaming.
//
// Hosted once at the app root and driven by `deviceEditorStore`, so the session
// menu can open it without threading props through every app's top bar.
//
// The work is one backend call. `reconfigure_device` writes the profile and
// then drops and re-establishes the live source, keeping the session id — so
// every app watching simply sees the device reconnect on its new settings.

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import Dialog, { DialogBody, DialogFooter, DialogHeader, DialogTitle } from "../components/Dialog";
import IOConnectionFields from "../components/io/IOConnectionFields";
import { useConnectionProbe, usePlatformInfo } from "../components/io/useConnectionProbe";
import { PrimaryButton, SecondaryButton } from "../components/forms";
import { reconfigureDevice } from "../api/ephemeralProfiles";
import { applyConnectionDefaults, validateProfileForm } from "../settings/ioProfileForm";
import { useDeviceEditorStore } from "../stores/deviceEditorStore";
import { useAllIOProfiles } from "../hooks/useAllIOProfiles";
import { getIOKindLabel } from "../utils/ioKindLabel";
import { iconSm } from "../styles/spacing";
import { caption } from "../styles";
import type { IOProfile, ConnectionFieldValue } from "../settings/appSettings";
import { Badge } from "../components/Badge";
import { Alert } from "../components/Alert";

export default function DeviceSettingsDialog() {
  const request = useDeviceEditorStore((s) => s.request);
  const close = useDeviceEditorStore((s) => s.close);
  const profiles = useAllIOProfiles();

  const profile = request ? profiles.find((p) => p.id === request.profileId) : undefined;
  // The device can be discarded from elsewhere while the dialog is open.
  if (!request || !profile) return null;

  return (
    <DeviceSettingsForm
      key={profile.id}
      profile={profile}
      sessionId={request.sessionId}
      onClose={close}
    />
  );
}

function DeviceSettingsForm({
  profile,
  sessionId,
  onClose,
}: {
  profile: IOProfile;
  sessionId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("dialogs");
  const platform = usePlatformInfo();

  // `as IOProfile`: the discriminated union does not survive a spread, so the
  // kind/connection correlation has to be reasserted.
  const [draft, setDraft] = useState<IOProfile>(
    () => ({ ...profile, connection: { ...profile.connection } }) as IOProfile,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isLive = !!sessionId;
  const conn = draft.connection as Record<string, unknown>;

  const updateConnectionField = useCallback((key: string, value: ConnectionFieldValue) => {
    setDraft((prev) => ({ ...prev, connection: { ...prev.connection, [key]: value } }) as IOProfile);
  }, []);

  // Laid over the stored connection, not the draft, so the draft's other edits
  // wait for Apply.
  const persistProbe = useCallback((fields: Record<string, unknown>) => {
    reconfigureDevice(profile.id, { ...profile.connection, ...fields }).catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [profile.id, profile.connection]);

  const probe = useConnectionProbe({
    profile: draft,
    // Probing opens the port, which a streaming session holds exclusively — it
    // would fail on every keystroke pause and report a working device as down.
    active: !sessionId,
    platform,
    probeProfileId: profile.id,
    onUpdateConnectionField: updateConnectionField as (key: string, value: unknown) => void,
    onPersistProbe: profile.ephemeral ? undefined : persistProbe,
    probeFailedText: t("deviceSettings.probeFailed"),
  });

  const apply = useCallback(async () => {
    // The same defaults and rejections a device gets when it is created, so the
    // two surfaces cannot disagree about what a valid device is.
    const resolved = applyConnectionDefaults(draft);
    const invalid = validateProfileForm(resolved, new Set());
    if (invalid) {
      setError(t(`deviceSettings.errors.${invalid}`));
      return;
    }

    setError(null);
    setBusy(true);
    try {
      await reconfigureDevice(
        profile.id,
        resolved.connection as Record<string, unknown>,
        sessionId,
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [profile.id, draft, sessionId, onClose, t]);

  return (
    <Dialog isOpen onClose={busy ? undefined : onClose} size="lg">
      <DialogHeader>
        <div>
          <DialogTitle className="truncate">{profile.name}</DialogTitle>
          <div className="flex items-center gap-2 mt-1">
            <Badge size="lg">{getIOKindLabel(profile.kind)}</Badge>
            {profile.ephemeral && (
              <span className={caption}>{t("deviceSettings.unsaved")}</span>
            )}
          </div>
        </div>
      </DialogHeader>
      <DialogBody className="max-h-[65vh] pt-0">
        <IOConnectionFields
          profile={draft}
          onUpdateConnectionField={updateConnectionField}
          probe={probe}
          platform={platform}
          canProbeByProfileId
          // Secrets are never read back out of the keyring: the stored marker
          // is shown, and the value only changes if the user types a new one.
          isPasswordSecurelyStored={!!conn._password_stored}
          isApiKeySecurelyStored={!!conn._api_key_stored}
        />

        {isLive && (
          <Alert tone="info" className="mt-4">{t("deviceSettings.liveHint")}</Alert>
        )}

        {error && (
          <Alert tone="warning" className="mt-4">{error}</Alert>
        )}
      </DialogBody>

      <DialogFooter className="justify-between">
        <p className={caption}>
          {profile.ephemeral
            ? t("deviceSettings.ephemeralFooter")
            : t("deviceSettings.savedFooter")}
        </p>
        <div className="flex items-center gap-2">
          <SecondaryButton onClick={onClose} disabled={busy}>
            {t("deviceSettings.cancel")}
          </SecondaryButton>
          <PrimaryButton onClick={() => void apply()} disabled={busy}>
            {busy && <Loader2 className={`${iconSm} animate-spin`} />}
            {isLive ? t("deviceSettings.applyReconnect") : t("deviceSettings.apply")}
          </PrimaryButton>
        </div>
      </DialogFooter>
    </Dialog>
  );
}

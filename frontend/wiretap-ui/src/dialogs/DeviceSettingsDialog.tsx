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
import { AlertCircle, Loader2, RefreshCw, X } from "lucide-react";
import Dialog from "../components/Dialog";
import IOConnectionFields from "../components/io/IOConnectionFields";
import { useConnectionProbe, usePlatformInfo } from "../components/io/useConnectionProbe";
import { PrimaryButton, SecondaryButton } from "../components/forms";
import { reconfigureDevice } from "../api/ephemeralProfiles";
import { applyConnectionDefaults, validateProfileForm } from "../settings/ioProfileForm";
import { useDeviceEditorStore } from "../stores/deviceEditorStore";
import { useAllIOProfiles } from "../hooks/useAllIOProfiles";
import { getIOKindLabel } from "../utils/ioKindLabel";
import { iconLg, iconSm } from "../styles/spacing";
import {
  h3,
  borderDefault,
  paddingCard,
  caption,
  alertInfo,
  alertWarning,
  hoverLight,
  roundedDefault,
  badgeNeutral,
  cardElevated,
} from "../styles";
import type { IOProfile, ConnectionFieldValue } from "../settings/appSettings";

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

  const probe = useConnectionProbe({
    profile: draft,
    // Probing opens the port, which a streaming session holds exclusively — it
    // would fail on every keystroke pause and report a working device as down.
    active: !sessionId,
    platform,
    probeProfileId: profile.id,
    onUpdateConnectionField: updateConnectionField as (key: string, value: unknown) => void,
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
    <Dialog isOpen onBackdropClick={busy ? undefined : onClose} maxWidth="max-w-lg">
      <div className={`${cardElevated} shadow-xl overflow-hidden`}>
        <div className={`${paddingCard} border-b ${borderDefault} flex items-start justify-between gap-3`}>
          <div className="min-w-0">
            <h2 className={`${h3} truncate`}>{profile.name}</h2>
            <div className="flex items-center gap-2 mt-1">
              <span className={badgeNeutral}>{getIOKindLabel(profile.kind)}</span>
              {profile.ephemeral && (
                <span className={caption}>{t("deviceSettings.unsaved")}</span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            aria-label={t("common:actions.close")}
            className={`p-1 ${roundedDefault} ${hoverLight} transition-colors disabled:opacity-50`}
          >
            <X className={iconLg} />
          </button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto px-6 pb-2">
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
            <div className={`${alertInfo} mt-4`}>
              <p className="text-sm text-[color:var(--text-info)] flex items-start gap-2">
                <RefreshCw className={`${iconSm} mt-0.5 shrink-0`} />
                <span>{t("deviceSettings.liveHint")}</span>
              </p>
            </div>
          )}

          {error && (
            <div className={`${alertWarning} mt-4`}>
              <p className="text-sm text-[color:var(--text-amber)] flex items-start gap-2">
                <AlertCircle className={`${iconSm} mt-0.5 shrink-0`} />
                <span>{error}</span>
              </p>
            </div>
          )}
        </div>

        <div className={`${paddingCard} border-t ${borderDefault} flex items-center justify-between gap-3`}>
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
        </div>
      </div>
    </Dialog>
  );
}

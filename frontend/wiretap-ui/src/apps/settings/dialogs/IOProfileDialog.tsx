// ui/src/apps/settings/dialogs/IOProfileDialog.tsx
//
// Add or edit a saved IO profile. The per-kind connection parameters live in
// the shared `IOConnectionFields`, which the source picker's device editor also
// renders; this dialog adds the identity (name, preferred decoder), the keyring
// handling, and the FrameLink signal panel, which is a Settings-only affair.

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { iconMd, iconXs, iconLg } from "../../../styles/spacing";
import { iconButtonHover } from "../../../styles/buttonStyles";
import Dialog from "../../../components/Dialog";
import type { IOProfile, ConnectionFieldValue } from "../../../hooks/useSettings";
import { isProfileKind } from "../../../hooks/useSettings";
import FrameLinkSignalControl, { signalSortKey } from "../components/FrameLinkSignalControl";
import {
  framelinkGetInterfaceSignals,
  framelinkWriteSignal,
  type SignalDescriptor,
} from "../../../api/framelink";
import { baseQuantity, QTY_DATARATE } from "../../../api/framelinkAxes";
import { Input, Select, FormField, PrimaryButton, SecondaryButton } from "../../../components/forms";
import IOConnectionFields from "../../../components/io/IOConnectionFields";
import { useConnectionProbe, usePlatformInfo } from "../../../components/io/useConnectionProbe";
import {
  h2,
  borderDefault,
  spaceYDefault,
  alertWarning,
  caption,
  textMedium,
  textMuted,
  textWarning,
  badgeNeutral,
  badgeCyan,
} from "../../../styles";
import { tlog } from "../../../api/settings";
import { useCatalogList } from "../../../hooks/useCatalogList";

type Props = {
  isOpen: boolean;
  editingProfileId: string | null;
  profileForm: IOProfile;
  /** Original profile from settings (before edits) - used to detect legacy passwords */
  originalProfile?: IOProfile | null;

  onCancel: () => void;
  onSave: () => void;
  /** Called when user wants to migrate a legacy password to secure storage */
  onMigratePassword?: () => void;

  onUpdateProfileField: (field: keyof IOProfile, value: any) => void;
  onUpdateConnectionField: (key: string, value: ConnectionFieldValue) => void;
};

export default function IOProfileDialog({
  isOpen,
  editingProfileId,
  profileForm,
  originalProfile,
  onCancel,
  onSave,
  onMigratePassword,
  onUpdateProfileField,
  onUpdateConnectionField,
}: Props) {
  const { t } = useTranslation("settings");
  const catalogs = useCatalogList();
  const platform = usePlatformInfo();

  // Check password storage status (only mqtt has a password field)
  const conn = profileForm.connection;
  const isPasswordSecurelyStored = !!('_password_stored' in conn && conn._password_stored);
  const isApiKeySecurelyStored = !!('_api_key_stored' in conn && conn._api_key_stored);
  // Legacy password exists if there's a password in the original profile that isn't marked as securely stored
  const origConn = originalProfile?.connection;
  const hasLegacyPassword = !!(
    origConn &&
    'password' in origConn && origConn.password &&
    !('_password_stored' in origConn && origConn._password_stored)
  );

  const probe = useConnectionProbe({
    profile: profileForm,
    active: isOpen,
    platform,
    // GVRET's probe resolves a profile by id, so a new profile must be saved first.
    probeProfileId: editingProfileId,
    onUpdateConnectionField: onUpdateConnectionField as (key: string, value: unknown) => void,
    probeFailedText: t("ioProfileDialog.probeFailed"),
  });

  // FrameLink interface configuration state — per-interface signal map keyed by iface_index
  const [flSignalsByIface, setFlSignalsByIface] = useState<Record<number, SignalDescriptor[]>>({});
  const [flLoading, setFlLoading] = useState(false);
  const [flFetched, setFlFetched] = useState(false);
  const [flError, setFlError] = useState<string | null>(null);
  const [flPersist, setFlPersist] = useState(true);
  const [flExpandedIface, setFlExpandedIface] = useState<Record<number, boolean>>({});

  // Reset FrameLink config state when dialog closes or profile type changes
  useEffect(() => {
    if (!isOpen || profileForm.kind !== "framelink") {
      setFlSignalsByIface({});
      setFlError(null);
      setFlLoading(false);
      setFlFetched(false);
      setFlExpandedIface({});
    }
  }, [isOpen, profileForm.kind]);

  const loadFlSignals = useCallback(async () => {
    if (!isProfileKind(profileForm, "framelink")) return;
    const { device_id, timeout: timeoutStr, interfaces } = profileForm.connection;
    const timeout = Number(timeoutStr) || 5;
    if (!device_id || !interfaces?.length) {
      setFlError("Device ID and interfaces are required");
      return;
    }
    setFlLoading(true);
    setFlError(null);
    try {
      const next: Record<number, SignalDescriptor[]> = {};
      for (const iface of interfaces) {
        next[iface.index] = await framelinkGetInterfaceSignals(device_id, iface.index, timeout);
      }
      setFlSignalsByIface(next);
      setFlFetched(true);
      tlog.debug(
        `[ioProfile/framelink] loaded signals: ${JSON.stringify(
          Object.entries(next).map(([idx, sigs]) => ({
            iface_index: Number(idx),
            count: sigs.length,
            ids: sigs.map((s) => s.signal_id),
            names: sigs.map((s) => s.name),
          })),
        )}`,
      );
    } catch (e) {
      setFlError(e instanceof Error ? e.message : String(e));
      setFlSignalsByIface({});
      setFlFetched(false);
    } finally {
      setFlLoading(false);
    }
  }, [profileForm]);

  // Auto-fetch signals when dialog opens for a framelink profile with valid connection
  useEffect(() => {
    if (isOpen && isProfileKind(profileForm, "framelink")) {
      const { device_id, interfaces } = profileForm.connection;
      if (device_id && Array.isArray(interfaces) && interfaces.length > 0) {
        loadFlSignals();
      }
    }
  }, [isOpen, profileForm.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFlWriteSignal = useCallback(
    async (signalId: number, value: number) => {
      if (!isProfileKind(profileForm, "framelink")) return;
      const { device_id, timeout: timeoutStr } = profileForm.connection;
      const timeout = Number(timeoutStr) || 5;
      if (!device_id) return;
      await framelinkWriteSignal(device_id, signalId, value, flPersist, timeout);
      // Update local state to reflect the written value, in whichever interface bucket the signal lives
      setFlSignalsByIface((prev) => {
        const next: Record<number, SignalDescriptor[]> = {};
        for (const [idx, sigs] of Object.entries(prev)) {
          next[Number(idx)] = sigs.map((s) =>
            s.signal_id === signalId ? { ...s, value, formatted_value: String(value) } : s,
          );
        }
        return next;
      });
    },
    [profileForm, flPersist],
  );

  // Interfaces the profile knows about, if it has been probed.
  const flInterfaces = (isProfileKind(profileForm, "framelink")
  && Array.isArray(profileForm.connection.interfaces)
    ? profileForm.connection.interfaces
    : []) as Array<{
    index: number;
    iface_type: number;
    name: string;
    type_name?: string;
  }>;
  const hasFlInterfaces = flInterfaces.length > 0;

  const totalSignalsLoaded = Object.values(flSignalsByIface).reduce((n, sigs) => n + sigs.length, 0);
  const anyPersistable = Object.values(flSignalsByIface).some((sigs) => sigs.some((s) => s.persistable));

  // The per-interface signal panel, passed into IOConnectionFields as a slot.
  // The probe row that populates `interfaces` lives in IOConnectionFields
  // itself, so the source picker gets it too.
  const frameLinkSignalPanel = (
    <>
      {flError && (
        <div className={`${alertWarning} mt-3`}>
          <p className={`text-sm ${textWarning}`}>{flError}</p>
        </div>
      )}

      {/* Interfaces — each row is collapsible and contains its own device configuration */}
      {hasFlInterfaces && (
        <div className={`border-t ${borderDefault} pt-4 mt-4`}>
          <div className="flex items-center justify-end mb-3">
            <SecondaryButton onClick={loadFlSignals} disabled={flLoading}>
              <RefreshCw className={`${iconXs} ${flLoading ? "animate-spin" : ""}`} />
              {flLoading
                ? t("ioProfileDialog.framelink.reading")
                : t("ioProfileDialog.framelink.refresh")}
            </SecondaryButton>
          </div>

          <div className="flex flex-col gap-1.5">
            {flInterfaces.map((iface) => {
              const ifaceSignals = flSignalsByIface[iface.index] ?? [];
              const expanded = !!flExpandedIface[iface.index];
              const bitrateSig = ifaceSignals.find((s) => baseQuantity(s.quantity) === QTY_DATARATE);
              const bitrateText = bitrateSig
                ? (bitrateSig.formatted_value || String(bitrateSig.value))
                : null;
              const isCanFd = iface.iface_type === 2;
              const grouped = ifaceSignals.reduce<Record<string, SignalDescriptor[]>>((acc, sig) => {
                const g = sig.group || t("ioProfileDialog.framelink.groupOther");
                (acc[g] ??= []).push(sig);
                return acc;
              }, {});

              return (
                <div key={iface.index} className={`rounded bg-[var(--bg-primary)] border ${borderDefault}`}>
                  <button
                    type="button"
                    onClick={() => setFlExpandedIface((prev) => ({ ...prev, [iface.index]: !prev[iface.index] }))}
                    className="w-full flex items-center justify-between py-2 px-2 text-left hover:bg-[var(--bg-surface)] transition-colors rounded"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {expanded ? <ChevronDown className={iconMd} /> : <ChevronRight className={iconMd} />}
                      <span className={textMedium}>{iface.name}</span>
                      {bitrateText && (
                        <span className={`${textMuted} text-xs ml-2 truncate`}>{bitrateText}</span>
                      )}
                    </div>
                    <span className={isCanFd ? badgeCyan : badgeNeutral}>
                      {iface.type_name ?? t("ioProfileDialog.framelink.interfaceUnknown")}
                    </span>
                  </button>

                  {expanded && (
                    <div className={`px-3 pb-3 pt-1 border-t ${borderDefault}`}>
                      {ifaceSignals.length === 0 && flLoading && (
                        <p className={caption}>{t("ioProfileDialog.framelink.readingConfig")}</p>
                      )}
                      {ifaceSignals.length === 0 && !flLoading && flFetched && (
                        <p className={caption}>{t("ioProfileDialog.framelink.configWillLoad")}</p>
                      )}
                      {ifaceSignals.length > 0 && (
                        <div className={spaceYDefault}>
                          {Object.entries(grouped).map(([group, signals]) => (
                            <div key={group}>
                              <h4 className={`${caption} uppercase tracking-wide mb-2`}>{group}</h4>
                              <div className={spaceYDefault}>
                                {[...signals].sort((a, b) => signalSortKey(a) - signalSortKey(b)).map((sig) => (
                                  <FrameLinkSignalControl
                                    key={sig.signal_id}
                                    signal={sig}
                                    isFetched={flFetched}
                                    onWrite={handleFlWriteSignal}
                                  />
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {totalSignalsLoaded === 0 && !flLoading && !flError && !flFetched && (
            <p className={`${caption} mt-3`}>
              {t("ioProfileDialog.framelink.configWillLoad")}
            </p>
          )}

          {anyPersistable && (
            <label className={`flex items-center gap-2 ${caption} mt-3`}>
              <input
                type="checkbox"
                checked={flPersist}
                onChange={(e) => setFlPersist(e.target.checked)}
              />
              {t("ioProfileDialog.framelink.persistChanges")}
            </label>
          )}
        </div>
      )}
    </>
  );

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-2xl">
      <div className="max-h-[90vh] overflow-y-auto">
        <div className={`p-6 border-b ${borderDefault} flex items-center justify-between`}>
          <h2 className={h2}>
            {editingProfileId ? t("ioProfileDialog.edit") : t("ioProfileDialog.add")}
          </h2>
          <button
            onClick={onCancel}
            className={iconButtonHover}
            title={t("ioProfileDialog.back")}
          >
            <ArrowLeft className={`${iconLg} text-[color:var(--text-muted)]`} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Profile Type - filtered based on platform availability */}
          <FormField label={t("ioProfileDialog.type")} variant="default">
            <Select
              variant="default"
              value={profileForm.kind}
              onChange={(e) =>
                onUpdateProfileField("kind", e.target.value as IOProfile["kind"])
              }
            >
              {platform.availableKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`ioProfileDialog.kinds.${kind}`)}
                </option>
              ))}
            </Select>
          </FormField>

          {/* Profile Name */}
          <FormField label={t("ioProfileDialog.profileName")} required variant="default">
            <Input
              variant="default"
              value={profileForm.name}
              onChange={(e) => onUpdateProfileField("name", e.target.value)}
              placeholder={t("ioProfileDialog.profileNamePlaceholder")}
            />
          </FormField>

          {/* Preferred Decoder */}
          <FormField label={t("ioProfileDialog.preferredDecoder")} variant="default">
            <Select
              variant="default"
              value={profileForm.preferred_catalog || ""}
              onChange={(e) => onUpdateProfileField("preferred_catalog", e.target.value || undefined)}
            >
              <option value="">{t("ioProfileDialog.none")}</option>
              {catalogs.map((c) => (
                <option key={c.filename} value={c.filename}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>

          <IOConnectionFields
            profile={profileForm}
            onUpdateConnectionField={onUpdateConnectionField}
            probe={probe}
            platform={platform}
            canProbeByProfileId={!!editingProfileId}
            isPasswordSecurelyStored={isPasswordSecurelyStored}
            isApiKeySecurelyStored={isApiKeySecurelyStored}
            hasLegacyPassword={hasLegacyPassword}
            onMigratePassword={onMigratePassword}
            frameLinkSignalPanel={frameLinkSignalPanel}
          />
        </div>

        {/* Actions */}
        <div className={`p-6 border-t ${borderDefault} flex justify-end gap-3`}>
          <SecondaryButton onClick={onCancel}>{t("ioProfileDialog.cancel")}</SecondaryButton>
          <PrimaryButton onClick={onSave}>
            {editingProfileId ? t("ioProfileDialog.update") : t("ioProfileDialog.addBtn")}
          </PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}

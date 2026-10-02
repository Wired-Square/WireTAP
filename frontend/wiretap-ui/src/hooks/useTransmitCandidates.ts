// src/hooks/useTransmitCandidates.ts

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { IOProfile } from "../settings/appSettings";
import { useProfileTraits } from "../stores/profileBusStore";
import type { ProfileDisabledStatus } from "../dialogs/io-source-picker/SourceList";

/** The profiles whose buses transmit, and why any of them cannot right now. */
export function useTransmitCandidates(ioProfiles: IOProfile[]) {
  const { t } = useTranslation("common");
  const traitsOf = useProfileTraits();
  return useMemo(() => {
    const profiles = ioProfiles.filter((p) => {
      const traits = traitsOf(p);
      return !!traits && (traits.tx_frames || traits.tx_bytes);
    });
    const status = new Map<string, ProfileDisabledStatus>(
      profiles.map((p) => {
        const blocked = traitsOf(p)?.tx_blocked;
        return [p.id, blocked ? { canTransmit: false, reason: t(`transmitBlocked.${blocked}`) } : { canTransmit: true }];
      }),
    );
    return { profiles, status };
  }, [ioProfiles, traitsOf, t]);
}

// src/hooks/useAllIOProfiles.ts
//
// Saved profiles plus the ad-hoc devices registered this run.
//
// Use this anywhere a device list feeds session start — both the
// `ioProfiles` option of useIOSessionManager and the `ioProfiles` prop of
// IoSourcePickerDialog. `watchSource` looks each id up in that array to decide
// the multi-source vs single-source fork, so an ad-hoc device missing from it
// would mis-route the session.
//
// Reads the settings *store* rather than `useSettings()`: the store is loaded
// once at startup, whereas each `useSettings()` call is its own loader with its
// own `load_settings` round trip and `settings-changed` listener — and every
// caller of this hook already has one. It also reflects a just-saved profile
// immediately, which the save-then-connect path in the picker depends on.

import { useMemo } from "react";
import { useSettingsStore } from "../apps/settings/stores/settingsStore";
import { useAdHocProfileStore } from "../stores/adHocProfileStore";
import type { IOProfile } from "../settings/appSettings";

export function useAllIOProfiles(): IOProfile[] {
  const saved = useSettingsStore((s) => s.ioProfiles.profiles);
  const adHoc = useAdHocProfileStore((s) => s.profiles);

  return useMemo(() => [...saved, ...adHoc], [saved, adHoc]);
}

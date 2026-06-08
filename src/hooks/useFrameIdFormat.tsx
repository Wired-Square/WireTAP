// ui/src/hooks/useFrameIdFormat.tsx
//
// Centralised resolution of how a CAN frame id is rendered on screen.
//
// The global default lives in settings (`display_frame_id_format`). Each app
// panel may layer a local override on top via the top-bar "Flip" control:
//   - "default" → follow the global setting
//   - "hex" / "decimal" → force that base for this panel only
//
// Resolution happens once per panel in FrameIdFormatProvider; render leaves
// read the resolved `effective` format (or the bound `format` helper) cheaply
// from context instead of each calling useSettings() and threading props.

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useSettings, getDisplayFrameIdFormat, type FrameIdFormat } from "./useSettings";
import { formatFrameId } from "../utils/frameIds";

/** Local per-panel override; "default" means "follow the global setting". */
export type FrameIdOverride = "default" | "hex" | "decimal";

export interface FrameIdFormatValue {
  /** Current local override for this panel. */
  override: FrameIdOverride;
  /** Cycle/set the local override (Default → Dec → Hex → Default). */
  setOverride: (next: FrameIdOverride) => void;
  /** The global default resolved from settings. */
  defaultFormat: FrameIdFormat;
  /** The format actually in effect = override unless "default". */
  effective: FrameIdFormat;
  /** Format an id with the effective format. */
  format: (id: number, isExtended?: boolean) => string;
}

const FALLBACK: FrameIdFormatValue = {
  override: "default",
  setOverride: () => {},
  defaultFormat: "hex",
  effective: "hex",
  format: (id, isExtended) => formatFrameId(id, "hex", isExtended),
};

const FrameIdFormatContext = createContext<FrameIdFormatValue | null>(null);

/**
 * Provide a per-panel frame-id format scope. Mount once near an app's root so
 * both its top bar (the Flip toggle) and its content tree share one override.
 */
export function FrameIdFormatProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const defaultFormat = getDisplayFrameIdFormat(settings);
  const [override, setOverride] = useState<FrameIdOverride>("default");

  const effective: FrameIdFormat = override === "default" ? defaultFormat : override;

  const value = useMemo<FrameIdFormatValue>(
    () => ({
      override,
      setOverride,
      defaultFormat,
      effective,
      format: (id, isExtended) => formatFrameId(id, effective, isExtended),
    }),
    // effective is derived from override + defaultFormat, so those two cover it.
    [override, defaultFormat, effective],
  );

  return (
    <FrameIdFormatContext.Provider value={value}>
      {children}
    </FrameIdFormatContext.Provider>
  );
}

/**
 * Read the effective frame-id format for the current panel. Falls back to a
 * sane default (hex, no-op override) when used outside a provider.
 */
export function useFrameIdFormat(): FrameIdFormatValue {
  return useContext(FrameIdFormatContext) ?? FALLBACK;
}

/** Wrap an app component so it (and its top bar toggle) share one panel override. */
export function withFrameIdFormat<P extends object>(Inner: ComponentType<P>) {
  return function WithFrameIdFormat(props: P) {
    return (
      <FrameIdFormatProvider>
        <Inner {...props} />
      </FrameIdFormatProvider>
    );
  };
}

/** Advance an override one step in the Flip cycle: Default → Dec → Hex → Default. */
const FLIP_CYCLE: FrameIdOverride[] = ["default", "decimal", "hex"];
export function nextFrameIdOverride(current: FrameIdOverride): FrameIdOverride {
  return FLIP_CYCLE[(FLIP_CYCLE.indexOf(current) + 1) % FLIP_CYCLE.length];
}

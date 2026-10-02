// src/hooks/useConnectionDefaults.ts

import { useEffect, useState } from "react";
import { defaultConnectionForKind, type ConnectionDefaults } from "../api/deviceKinds";
import { tlog } from "../api/settings";

const NONE: ConnectionDefaults = {};

/** A kind's default connection map from Rust; empty until it arrives. */
export function useConnectionDefaults(kind: string): ConnectionDefaults {
  const [loaded, setLoaded] = useState<{ kind: string; defaults: ConnectionDefaults }>();
  useEffect(() => {
    let live = true;
    defaultConnectionForKind(kind)
      .then((defaults) => live && setLoaded({ kind, defaults }))
      .catch((e) => tlog.info(`[useConnectionDefaults] ${kind}: ${e}`));
    return () => {
      live = false;
    };
  }, [kind]);
  return loaded?.kind === kind ? loaded.defaults : NONE;
}

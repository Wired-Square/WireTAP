// ui/src/hooks/useIsIOS.ts
//
// Whether this build is running on iOS, for the handful of controls that have no
// iOS equivalent — revealing a path in a file manager, serial ports, and the like.
//
// `getPlatform()` is async but caches after its first call, and the app resolves it
// during startup, so in practice the answer is known before any panel renders. The
// state exists only for that first, pre-cache render.

import { useEffect, useState } from "react";
import { isIOS } from "../utils/platform";

export function useIsIOS(): boolean {
  const [ios, setIos] = useState(false);

  useEffect(() => {
    void isIOS().then(setIos);
  }, []);

  return ios;
}

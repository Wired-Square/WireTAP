// ui/src/apps/dashboard/widgets/useHistoryQuery.ts

import { useCallback, useEffect, useRef, useState } from "react";
import { useDashboardStore } from "../../../stores/dashboardStore";
import { tlog } from "../../../api/settings";

/** Re-reads the session's history on each delivery and whenever `key` changes,
 *  one request at a time; a delivery during one asks again when it lands. */
export function useHistoryQuery<T>(key: string, read: (sessionId: string) => Promise<T>): T | null {
  const sessionId = useDashboardStore((s) => s.sessionId);
  const dataVersion = useDashboardStore((s) => s.dataVersion);
  const [result, setResult] = useState<T | null>(null);
  const current = useRef({ sessionId, read });
  current.current = { sessionId, read };
  const flight = useRef({ busy: false, again: false });

  const request = useCallback(() => {
    if (flight.current.busy) {
      flight.current.again = true;
      return;
    }
    const { sessionId, read } = current.current;
    if (!sessionId) {
      setResult(null);
      return;
    }
    flight.current.busy = true;
    read(sessionId)
      .then(setResult, (e) => tlog.debug(`[Dashboard] history read failed: ${e}`))
      .finally(() => {
        flight.current.busy = false;
        if (flight.current.again) {
          flight.current.again = false;
          request();
        }
      });
  }, []);

  useEffect(request, [sessionId, dataVersion, key, request]);
  return result;
}

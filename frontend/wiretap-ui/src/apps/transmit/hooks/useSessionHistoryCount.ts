import { useEffect, useState } from "react";
import { useTransmitStore } from "../../../stores/transmitStore";
import { transmitHistoryCount } from "../../../api/transmitHistory";

/** The session's transmit history row count, refetched whenever any history is written. */
export function useSessionHistoryCount(sessionId: string | null | undefined): number {
  const historyDbCount = useTransmitStore((s) => s.historyDbCount);
  const [counted, setCounted] = useState<{ sessionId: string; count: number } | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    transmitHistoryCount(sessionId)
      .then((count) => { if (!cancelled) setCounted({ sessionId, count }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId, historyDbCount]);

  return counted && counted.sessionId === sessionId ? counted.count : 0;
}

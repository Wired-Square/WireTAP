// ui/src/apps/serial/hooks/useSerialPortPicker.ts
//
// Lists all serial ports available on the system and annotates each one with
// the matching `kind: "serial"` IO profile (if any) so the picker can offer
// the saved baud / data bits / parity / stop bits as defaults.

import { useCallback, useEffect, useState } from "react";
import { listSerialPorts } from "../../../api/serial";
import { tlog } from "../../../api/settings";
import type { IOProfile } from "../../../hooks/useSettings";
import type { AnnotatedSerialPort } from "../../../components/SerialPortPicker";

export type { AnnotatedSerialPort };

export function useSerialPortPicker(profiles: IOProfile[]) {
  const [ports, setPorts] = useState<AnnotatedSerialPort[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listSerialPorts();
      const serialProfiles = profiles.filter(
        (p): p is Extract<IOProfile, { kind: "serial" }> => p.kind === "serial",
      );
      const annotated: AnnotatedSerialPort[] = list.map((info) => ({
        info,
        profile:
          serialProfiles.find((p) => p.connection.port === info.port_name) ?? null,
      }));
      setPorts(annotated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      tlog.info(`[Serial] Failed to list ports: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [profiles]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ports, loading, error, refresh };
}

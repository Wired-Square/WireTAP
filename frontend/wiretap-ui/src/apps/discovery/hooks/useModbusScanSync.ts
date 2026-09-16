// ui/src/apps/discovery/hooks/useModbusScanSync.ts

import { useEffect } from "react";
import { wsTransport } from "../../../services/wsTransport";
import { MsgType, decodeWsJson, type ModbusScanStateMsg } from "../../../services/wsProtocol";
import { runningModbusScan, useDiscoveryToolboxStore } from "../../../stores/discoveryToolboxStore";

/**
 * Feed the toolbox store from the running sweep's progress messages.
 *
 * Subscribes directly rather than adding a `SessionCallbacks` entry: that would
 * put a Modbus-specific callback in a generic session interface, which is the
 * layering this message type was moved to the session channel to avoid.
 *
 * Keyed on whichever scan is still running, so the subscription lasts exactly as
 * long as the sweep. The result keeps its session id afterwards — that is how its
 * tab knows whether the frames on screen are still its own — so the id alone
 * would keep this alive for the life of the tab.
 */
export function useModbusScanSync() {
  const scanSessionId = useDiscoveryToolboxStore(
    (s) => runningModbusScan(s.toolbox)?.sessionId ?? null
  );

  useEffect(() => {
    if (!scanSessionId) return;

    return wsTransport.onSessionMessage(
      scanSessionId,
      MsgType.ModbusScanState,
      (_payload, raw) => {
        let state: ModbusScanStateMsg;
        try {
          state = decodeWsJson<ModbusScanStateMsg>(raw);
        } catch {
          return;
        }

        const store = useDiscoveryToolboxStore.getState();
        // Recorded from the sweep's own messages rather than observed from the
        // session Discovery happens to be joined to: the tab needs it after the
        // app has moved on, which is exactly when nothing is observing.
        if (state.capture_id) store.setModbusScanCapture(scanSessionId, state.capture_id);
        if (state.progress) store.updateModbusScanProgress(state.progress, state.notes);
        store.setModbusScanDevices(state.device_info);
        // The sweep publishes a terminal status on its way out — the start call
        // returned as soon as the session was running, long before there was
        // anything to report.
        if (state.status !== "scanning") store.finishModbusScan(state.notes);
      }
    );
  }, [scanSessionId]);
}

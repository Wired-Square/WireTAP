// Trial-only: renders the session graph on fixture data in a plain browser
// (`npm run dev`, then /session-canvas-trial.html). Nothing in the app imports it.

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasScope } from "@wired-square/canvas/react";
import "../../../WireTAP.css";
import "../../../i18n";
import type { ActiveSessionInfo, AppInstanceInfo, BusMapping } from "../../../api/io";
import type { IOProfile } from "../../../hooks/useSettings";
import { useProfileBusStore } from "../../../stores/profileBusStore";
import { useSessionManagerStore } from "../stores/sessionManagerStore";
import SessionCanvas from "../views/SessionCanvas";
import { Button } from "../../../components/Button";

const mapping = (deviceBus: number, outputBus: number, enabled = true): BusMapping => ({
  device_bus: deviceBus,
  output_bus: outputBus,
  enabled,
  interface_id: `can${deviceBus}`,
  protocol: "can",
  supported_protocols: [],
  traits: null,
});

const profiles = [
  { id: "gvret_bench", name: "Bench GVRET", kind: "gvret_tcp", connection: {} },
  { id: "slcan_car", name: "Car SLCAN", kind: "slcan", connection: {} },
] as unknown as IOProfile[];

const subscriber = (id: string, appName: string, isActive = true) => ({
  subscriber_id: id,
  app_name: appName,
  registered_seconds_ago: 42,
  is_active: isActive,
});

const session = (
  id: string,
  state: "Running" | "Paused" | "Stopped",
  configs: Array<[string, BusMapping[]]>,
  subscribers: ReturnType<typeof subscriber>[] = [],
): ActiveSessionInfo =>
  ({
    session_id: id,
    source_type: "multi_source",
    state: { type: state },
    capabilities: {},
    subscriber_count: subscribers.length,
    subscribers,
    broker_configs: configs.map(([profileId, busMappings]) => ({ profile_id: profileId, bus_mappings: busMappings, display_name: profileId })),
    source_profile_ids: configs.map(([profileId]) => profileId),
    capture_id: null,
    capture_frame_count: state === "Running" ? 12840 : null,
    is_streaming: state === "Running",
  }) as unknown as ActiveSessionInfo;

const initialSessions = [
  session(
    "f_bench-1",
    "Running",
    [["gvret_bench", [mapping(0, 0)]], ["slcan_car", [mapping(0, 1)]]],
    [subscriber("discovery_a1", "discovery"), subscriber("decoder_b2", "decoder")],
  ),
  session("f_car-2", "Paused", [["slcan_car", [mapping(0, 0)]]], [subscriber("graph_c3", "graph", false)]),
  session("f_bench-3", "Stopped", [["gvret_bench", [mapping(1, 0, false)]]]),
];

const app = (id: string, appName: string, sessionId: string | null): AppInstanceInfo => ({
  instance_id: id,
  display_id: id,
  app_name: appName,
  window_label: "main",
  session_id: sessionId,
  registered_seconds_ago: 42,
  is_active: sessionId !== null,
});

const initialApps = [
  app("discovery_a1", "discovery", "f_bench-1"),
  app("decoder_b2", "decoder", "f_bench-1"),
  app("graph_c3", "graph", "f_car-2"),
  app("transmit_d4", "transmit", null),
];

useProfileBusStore.setState({
  mappings: new Map([
    ["gvret_bench", [mapping(0, 0), mapping(1, 1)]],
    ["slcan_car", [mapping(0, 0)]],
  ]),
  loaded: true,
});

function withMapping(sessions: ActiveSessionInfo[], sessionId: string, profileId: string, update: (mappings: BusMapping[]) => BusMapping[]) {
  return sessions.map((s): ActiveSessionInfo =>
    s.session_id !== sessionId
      ? s
      : {
          ...s,
          broker_configs: s.broker_configs?.map((c) => (c.profile_id === profileId ? { ...c, bus_mappings: update(c.bus_mappings) } : c)) ?? null,
        },
  );
}

function Trial() {
  const [sessions, setSessions] = useState(initialSessions);
  const [openApps, setOpenApps] = useState(initialApps);
  const [log, setLog] = useState<string[]>([]);
  const selected = useSessionManagerStore((s) => s.selectedNode);
  const report = (line: string) => setLog((prev) => [line, ...prev].slice(0, 8));

  const onEnableBusMapping = (sessionId: string, profileId: string, deviceBus: number, outputBus: number) => {
    report(`enable ${profileId} bus${deviceBus} → ${sessionId} bus${outputBus}`);
    setSessions((prev) =>
      withMapping(prev, sessionId, profileId, (ms) =>
        ms.map((m) => (m.device_bus === deviceBus && m.output_bus === outputBus ? { ...m, enabled: true } : m)),
      ),
    );
  };

  const onCreateBusMapping = (sessionId: string, profileId: string, deviceBus: number, outputBus: number) => {
    report(`create ${profileId} bus${deviceBus} → ${sessionId} bus${outputBus}`);
    setSessions((prev) =>
      withMapping(prev, sessionId, profileId, (ms) => [...ms.filter((m) => m.device_bus !== deviceBus), mapping(deviceBus, outputBus)]),
    );
  };

  const onConnectAppToSession = (sessionId: string, appName: string) => {
    report(`connect ${appName} → ${sessionId}`);
    const joining = openApps.find((a) => a.app_name === appName && a.session_id === null);
    if (!joining) return;
    setOpenApps((prev) => prev.map((a) => (a === joining ? { ...a, session_id: sessionId, is_active: true } : a)));
    setSessions((prev) =>
      prev.map((s) =>
        s.session_id === sessionId
          ? { ...s, subscribers: [...s.subscribers, subscriber(joining.instance_id, appName)], subscriber_count: s.subscriber_count + 1 }
          : s,
      ),
    );
  };

  const toggleSpareSession = () =>
    setSessions((prev) =>
      prev.some((s) => s.session_id === "f_spare-4")
        ? prev.filter((s) => s.session_id !== "f_spare-4")
        : [...prev, session("f_spare-4", "Running", [["slcan_car", [mapping(0, 0)]]])],
    );

  return (
    <div className="flex flex-col bg-primary text-primary" style={{ height: "100vh" }}>
      <div className="flex items-center gap-2 p-2 border-b border-default text-xs">
        <Button size="sm" onClick={() => document.documentElement.classList.toggle("dark")}>Theme</Button>
        <Button size="sm" onClick={toggleSpareSession}>Add/remove session</Button>
        <span className="text-muted">selected: {selected ? `${selected.type} ${selected.id}` : "none"}</span>
        <span className="text-muted truncate">{log.join(" · ")}</span>
      </div>
      <div className="flex-1 min-h-0">
        <CanvasScope>
          <SessionCanvas
            sessions={sessions}
            profiles={profiles}
            openApps={openApps}
            onEnableBusMapping={onEnableBusMapping}
            onCreateBusMapping={onCreateBusMapping}
            onConnectAppToSession={onConnectAppToSession}
          />
        </CanvasScope>
      </div>
    </div>
  );
}

if (new URLSearchParams(location.search).has("dark")) document.documentElement.classList.add("dark");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Trial />
  </StrictMode>,
);

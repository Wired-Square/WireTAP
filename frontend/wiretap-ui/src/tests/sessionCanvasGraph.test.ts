// src/tests/sessionCanvasGraph.test.ts

import { describe, it, expect } from "vitest";
import type { ActiveSessionInfo, BusMapping } from "../api/io";
import type { IOProfile } from "../hooks/useSettings";
import { buildSessionGraph } from "../apps/session-manager/utils/layoutUtils";
import { resolveConnection } from "../apps/session-manager/utils/graphConnections";
import { forgetGone, placeDragged } from "../apps/session-manager/utils/draggedPositions";

const mapping = (deviceBus: number, outputBus: number, enabled = true): BusMapping => ({
  device_bus: deviceBus,
  output_bus: outputBus,
  enabled,
  interface_id: `can${deviceBus}`,
  protocol: "can",
  supported_protocols: [],
  traits: null,
});

const subscriber = (id: string) => ({ subscriber_id: id, app_name: "discovery", registered_seconds_ago: 1, is_active: true });

const session = (
  id: string,
  configs: Array<[string, BusMapping[]]>,
  subscribers: ReturnType<typeof subscriber>[] = [],
): ActiveSessionInfo =>
  ({
    session_id: id,
    source_type: "multi_source",
    state: { type: "Running" },
    capabilities: {},
    subscriber_count: subscribers.length,
    subscribers,
    broker_configs: configs.map(([profileId, busMappings]) => ({ profile_id: profileId, bus_mappings: busMappings, display_name: profileId })),
    source_profile_ids: configs.map(([profileId]) => profileId),
    capture_id: null,
    capture_frame_count: 12840,
    is_streaming: true,
  }) as unknown as ActiveSessionInfo;

const profile = (id: string) => ({ id, name: id, kind: "gvret_tcp", connection: {} }) as unknown as IOProfile;

describe("resolveConnection", () => {
  const sessions = [
    session("bench", [["gvret", [mapping(0, 0), mapping(1, 2, false)]], ["slcan", [mapping(0, 1)]]]),
    session("car", [["slcan", [mapping(0, 0)]]]),
  ];
  const bus = (profileId: string, deviceBus: number, sessionId: string, outputBus: number) =>
    resolveConnection(sessions, `source-${profileId}`, `out-bus${deviceBus}`, `session-${sessionId}`, `in-bus${outputBus}`);

  it("refuses a mapping that is already wired", () => {
    expect(bus("slcan", 0, "bench", 1)).toBeUndefined();
  });

  it("refuses an output bus another mapping already carries", () => {
    expect(bus("gvret", 0, "bench", 1)).toBeUndefined();
    expect(bus("gvret", 1, "bench", 0)).toBeUndefined();
  });

  it("re-enables a disabled mapping and creates a new one", () => {
    expect(bus("gvret", 1, "bench", 2)).toMatchObject({ kind: "bus", reenable: true });
    expect(bus("gvret", 1, "bench", 3)).toEqual({ kind: "bus", profileId: "gvret", sessionId: "bench", deviceBus: 1, outputBus: 3, reenable: false });
  });

  it("refuses a source the session does not read", () => {
    expect(bus("gvret", 0, "car", 1)).toBeUndefined();
  });

  it("connects a session to an unconnected app, session first", () => {
    expect(resolveConnection(sessions, "session-car", "out-0", "app::transmit_d4", "in")).toEqual({
      kind: "app",
      sessionId: "car",
      instanceId: "transmit_d4",
    });
  });

  it("refuses an app already connected", () => {
    expect(resolveConnection(sessions, "session-car", "out-1", "app::bench::discovery_a1", "in")).toBeUndefined();
  });
});

describe("dragged positions", () => {
  const nodes = [
    { id: "a", x: 0, y: 0, data: null },
    { id: "b", x: 0, y: 100, data: null },
  ];

  it("places a dragged node at its dragged position across a changed node set", () => {
    const dragged = new Map([["b", { x: 40, y: 60 }]]);
    const grown = [...nodes, { id: "c", x: 0, y: 200, data: null }];
    expect(placeDragged(grown, forgetGone(dragged, grown)).map(({ x, y }) => [x, y])).toEqual([[0, 0], [40, 60], [0, 200]]);
  });

  it("forgets a node that has gone, and keeps the map when none has", () => {
    const dragged = new Map([["b", { x: 40, y: 60 }]]);
    expect(forgetGone(dragged, nodes)).toBe(dragged);
    expect(forgetGone(dragged, [nodes[0]]).size).toBe(0);
  });
});

describe("buildSessionGraph layout", () => {
  it("stacks session rows below the tallest of the session and its apps", () => {
    const graph = buildSessionGraph(
      [
        session("bench", [["gvret", [mapping(0, 0)]], ["slcan", [mapping(0, 1)]]], [subscriber("a1"), subscriber("b2"), subscriber("c3")]),
        session("car", [["slcan", [mapping(0, 0)]]]),
      ],
      [profile("gvret"), profile("slcan")],
    );
    const y = (id: string) => graph.nodes.find((n) => n.id === id)!.y;
    // A running session with frames renders about 134px tall.
    expect(y("session-car") - y("session-bench")).toBeGreaterThan(134);
    expect(y("session-car")).toBeGreaterThan(y("app::bench::c3") + 48);
  });
});

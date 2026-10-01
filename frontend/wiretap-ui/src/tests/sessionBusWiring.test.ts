// src/tests/sessionBusWiring.test.ts
//
// The bus half of session creation: what the picker/session hands Rust, and
// what the Sessions → Visual graph draws from what comes back.
//
// A 2-bus GVRET shipped as a single bus for five months because nothing here
// was covered — the frames still arrived (an unmapped device bus passes through
// un-remapped), so only the graph and the bus selector ever showed the loss.

import { describe, it, expect, beforeEach } from "vitest";
import {
  offsetBusMappings,
  probedBusMappings,
  type ActiveSessionInfo,
  type BusMapping,
} from "../api/io";
import {
  useProfileBusStore,
  profileBusMappings,
  kindSupportedProtocols,
} from "../stores/profileBusStore";
import { busProtocol } from "../utils/profileTraits";
import { buildSessionGraph } from "../apps/session-manager/utils/layoutUtils";
import type { SourceNodeData } from "../apps/session-manager/nodes/SourceNode";
import type { SessionNodeData } from "../apps/session-manager/nodes/SessionNode";
import type { IOProfile } from "../hooks/useSettings";

const mapping = (deviceBus: number, outputBus: number, enabled = true): BusMapping => ({
  device_bus: deviceBus,
  output_bus: outputBus,
  enabled,
  interface_id: `can${deviceBus}`,
  protocol: "can",
  supported_protocols: [],
  traits: null,
});

const profile = (id: string, name = "Dev"): IOProfile =>
  ({ id, name, kind: "gvret_tcp", connection: {} }) as unknown as IOProfile;

/** A running session carrying `busMappings` from one profile. */
const session = (
  sessionId: string,
  configs: Array<{ profileId: string; busMappings: BusMapping[] }>,
): ActiveSessionInfo =>
  ({
    session_id: sessionId,
    source_type: "gvret_tcp",
    state: { type: "Running" },
    capabilities: {},
    subscriber_count: 0,
    subscribers: [],
    broker_configs: configs.map((c) => ({
      profile_id: c.profileId,
      bus_mappings: c.busMappings,
      display_name: "Dev",
    })),
    source_profile_ids: configs.map((c) => c.profileId),
    capture_id: null,
    capture_frame_count: null,
    is_streaming: true,
  }) as unknown as ActiveSessionInfo;

const sourceData = (graph: ReturnType<typeof buildSessionGraph>, profileId: string) =>
  graph.nodes.find((n) => n.id === `source-${profileId}`)?.data as SourceNodeData;

const sessionData = (graph: ReturnType<typeof buildSessionGraph>, sessionId: string) =>
  graph.nodes.find((n) => n.id === `session-${sessionId}`)?.data as SessionNodeData;

describe("offsetBusMappings", () => {
  const declared = [mapping(0, 0), mapping(1, 1)];

  it("is identity at offset 0, reference included", () => {
    expect(offsetBusMappings(declared, 0)).toBe(declared);
  });

  it("shifts output buses without touching device buses", () => {
    const shifted = offsetBusMappings(declared, 2);
    expect(shifted.map((m) => m.output_bus)).toEqual([2, 3]);
    expect(shifted.map((m) => m.device_bus)).toEqual([0, 1]);
  });
});

describe("profileBusStore accessors", () => {
  beforeEach(() => {
    useProfileBusStore.setState({
      mappings: new Map([["io_declared", [mapping(0, 0), mapping(1, 1)]]]),
      supportedProtocols: new Map([["gvret_tcp", ["can", "canfd"]]]),
      loaded: true,
    });
  });

  it("reports the declared buses for a profile that has them", () => {
    expect(profileBusMappings("io_declared")).toHaveLength(2);
  });

  it("reports nothing — not one bus — for a profile that declares none", () => {
    // Rust omits these, so the caller can prefer a live probe. Answering "one
    // bus" here is what let a stale guess outrank a probe that found two.
    expect(profileBusMappings("io_bare")).toEqual([]);
  });

  it("applies an output bus offset on read", () => {
    expect(profileBusMappings("io_declared", 4).map((m) => m.output_bus)).toEqual([4, 5]);
  });

  it("offers no protocol options for a kind it has not heard of", () => {
    expect(kindSupportedProtocols("io_nonesuch")).toEqual([]);
    expect(kindSupportedProtocols(undefined)).toEqual([]);
  });

  it("reports the protocols a kind's bus may be set to", () => {
    expect(kindSupportedProtocols("gvret_tcp")).toEqual(["can", "canfd"]);
  });
});

describe("probedBusMappings", () => {
  it("seeds a probed-but-unconfigured device with the kind's options", () => {
    // A GVRET nobody has configured still needs a dropdown, so the options come
    // from the kind rather than from a mapping that does not exist yet.
    const seeded = probedBusMappings(2, 0, ["can", "canfd"]);

    expect(seeded).toHaveLength(2);
    expect(seeded[0].protocol).toBe("can");
    expect(seeded[0].supported_protocols).toEqual(["can", "canfd"]);
    expect(seeded.map((m) => m.output_bus)).toEqual([0, 1]);
    expect(seeded.every((m) => m.traits === null)).toBe(true);
  });
});

describe("buildSessionGraph — bus wiring", () => {
  const profiles = [profile("io_a", "Josh Remote 2323")];

  it("draws one edge per enabled bus, onto matching handles", () => {
    const graph = buildSessionGraph(
      [session("f_1", [{ profileId: "io_a", busMappings: [mapping(0, 0), mapping(1, 1)] }])],
      profiles,
    );

    const edges = graph.edges.filter((e) => e.source === "source-io_a");
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.sourceHandle)).toEqual(["out-bus0", "out-bus1"]);
    expect(edges.map((e) => e.targetHandle)).toEqual(["in-bus0", "in-bus1"]);

    expect(sourceData(graph, "io_a").outputBuses).toEqual([0, 1]);
    expect(sessionData(graph, "f_1").inputBuses).toEqual([0, 1]);
  });

  it("shows a declared bus the session is not carrying, so it can be dragged in", () => {
    const graph = buildSessionGraph(
      [session("f_1", [{ profileId: "io_a", busMappings: [mapping(0, 0)] }])],
      profiles,
      undefined,
      undefined,
      new Map([["io_a", [mapping(0, 0), mapping(1, 1)]]]),
    );

    const source = sourceData(graph, "io_a");
    // bus 0 is wired, bus 1 is declared but unwired
    expect(source.outputBuses).toEqual([0]);
    expect(source.disabledBuses).toEqual([1]);
    // Only the wired bus gets an edge; the spare handle is the drop target.
    expect(graph.edges.filter((e) => e.source === "source-io_a")).toHaveLength(1);
  });

  it("keeps a bus the session explicitly disabled visible", () => {
    const graph = buildSessionGraph(
      [session("f_1", [{ profileId: "io_a", busMappings: [mapping(0, 0), mapping(1, 1, false)] }])],
      profiles,
    );

    expect(sourceData(graph, "io_a").disabledBuses).toEqual([1]);
    expect(sessionData(graph, "f_1").disabledInputBuses).toEqual([1]);
    expect(graph.edges.filter((e) => e.source === "source-io_a")).toHaveLength(1);
  });

  it("does not give the session two input handles with the same id", () => {
    // Two sources colliding on one output bus produced duplicate `in-bus0`
    // handles, which breaks React Flow's drop targeting. Unreachable while
    // every source had exactly one bus.
    const graph = buildSessionGraph(
      [
        session("f_1", [
          { profileId: "io_a", busMappings: [mapping(0, 0)] },
          { profileId: "io_b", busMappings: [mapping(0, 0)] },
        ]),
      ],
      [profile("io_a"), profile("io_b")],
    );

    const inputBuses = sessionData(graph, "f_1").inputBuses ?? [];
    expect(inputBuses).toEqual([...new Set(inputBuses)]);
    expect(inputBuses).toEqual([0]);
  });

  it("gives every wired bus a distinct edge id", () => {
    const graph = buildSessionGraph(
      [session("f_1", [{ profileId: "io_a", busMappings: [mapping(0, 0), mapping(1, 1)] }])],
      profiles,
    );

    const ids = graph.edges.map((e) => e.id);
    expect(ids).toEqual([...new Set(ids)]);
  });
});

describe("busProtocol — the single-bus source's one protocol", () => {
  const slcan = (connection: Record<string, unknown>): IOProfile =>
    ({ id: "io_1", name: "CANable", kind: "slcan", connection }) as unknown as IOProfile;

  it("reads CAN FD off the device's own enable_fd", () => {
    expect(busProtocol(slcan({ enable_fd: true }))).toBe("canfd");
  });

  it("is classic CAN when FD is off", () => {
    expect(busProtocol(slcan({ enable_fd: false }))).toBe("can");
    expect(busProtocol(slcan({}))).toBe("can");
  });

  it("answers for a non-CAN kind too", () => {
    const modbus = { id: "io_2", name: "PLC", kind: "modbus_tcp", connection: {} };
    expect(busProtocol(modbus as unknown as IOProfile)).toBe("modbus");
  });

  it("falls back to CAN for a kind it has no traits for, or no profile at all", () => {
    const unknown = { id: "io_3", name: "?", kind: undefined, connection: {} };
    expect(busProtocol(unknown as unknown as IOProfile)).toBe("can");
    expect(busProtocol(undefined)).toBe("can");
  });
});

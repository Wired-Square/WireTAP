// src/apps/session-manager/utils/layoutUtils.ts

import type { CanvasEdge, CanvasNode } from "@wired-square/canvas/core";
import type { ActiveSessionInfo, AppInstanceInfo, BusMapping } from "../../../api/io";
import type { IOProfile } from "../../../hooks/useSettings";
import { isRealtimeProfile } from "../../../stores/profileBusStore";
import type { SourceNodeData } from "../nodes/SourceNode";
import type { SessionNodeData } from "../nodes/SessionNode";
import type { AppNodeData } from "../nodes/AppNode";
import type { InterfaceEdgeData } from "../edges/InterfaceEdge";

const COLUMN_SPACING = 300;
const NODE_GAP = 30;
const APP_SPACING = 72;
const START_X = 50;
const START_Y = 50;
const DEFAULT_CURVATURE = 0.25;
const INTERFACE_CURVATURE = 0.4;

// Expected node heights, from the nodes' padding, borders and line heights.
const NODE_CHROME = 28;
const BUS_ROW = 18;
const APP_HEIGHT = NODE_CHROME + 20;

function sourceHeight({ outputBuses, disabledBuses, captureCount }: SourceNodeData): number {
  const buses = (outputBuses?.length ?? 0) + (disabledBuses?.length ?? 0);
  return NODE_CHROME + 40 + (captureCount != null ? 16 : 0) + (buses > 0 ? 4 + buses * BUS_ROW : 0);
}

function sessionHeight({ session, inputBuses, disabledInputBuses }: SessionNodeData): number {
  const content = 86 + (session.capture_frame_count ? 20 : 0);
  const inputs = ((inputBuses?.length ?? 0) + (disabledInputBuses?.length ?? 0) + 1) * BUS_ROW - 4;
  return NODE_CHROME + Math.max(content, inputs);
}

export const APP_INPUT_PORT = "in";

export type GraphNodeData =
  | (SourceNodeData & { kind: "source" })
  | (SessionNodeData & { kind: "session" })
  | (AppNodeData & { kind: "app" });

export type GraphNode = CanvasNode<GraphNodeData>;
export type GraphEdge = CanvasEdge<InterfaceEdgeData>;

export interface SessionGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Buffer metadata for source node display */
export interface CaptureInfo {
  name: string;
  persistent: boolean;
  count: number;
  captureKind: string;
}

/**
 * Transform session data into canvas nodes and edges.
 * @param captureInfoMap Optional map of capture_id → metadata for capture source nodes.
 * @param openApps Open session-aware app instances across all windows (Rust-owned
 *   roster). Instances with `sessionId == null` become the unconnected app nodes.
 * @param profileBuses Every bus each profile declares, from profileBusStore.
 *   Drives the spare handles for buses not wired into a session.
 */
export function buildSessionGraph(
  sessions: ActiveSessionInfo[],
  profiles: IOProfile[],
  captureInfoMap?: Map<string, CaptureInfo>,
  openApps?: AppInstanceInfo[],
  profileBuses?: Map<string, BusMapping[]>,
): SessionGraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Track which profiles are actively used by sessions
  const activeProfileIds = new Set<string>();
  sessions.forEach((session) => {
    session.source_profile_ids.forEach((id) => activeProfileIds.add(id));
  });

  // Build a map of profileId → lowest outputBus for sorting source nodes
  // to match the vertical order of session input handles (avoids edge crossings)
  const profileOutputBus = new Map<string, number>();
  sessions.forEach((session) => {
    session.broker_configs?.forEach((config) => {
      const firstEnabled = config.bus_mappings.find((m) => m.enabled);
      if (firstEnabled && !profileOutputBus.has(config.profile_id)) {
        profileOutputBus.set(config.profile_id, firstEnabled.output_bus);
      }
    });
  });

  // Build profileId → Set<deviceBus> for output handles on source nodes
  const profileDeviceBuses = new Map<string, Set<number>>();
  const profileDisabledBuses = new Map<string, Set<number>>();
  sessions.forEach((session) => {
    session.broker_configs?.forEach((config) => {
      const enabledSet = profileDeviceBuses.get(config.profile_id) ?? new Set();
      const disabledSet = profileDisabledBuses.get(config.profile_id) ?? new Set();
      for (const m of config.bus_mappings) {
        if (m.enabled) {
          enabledSet.add(m.device_bus);
          disabledSet.delete(m.device_bus);
        } else if (!enabledSet.has(m.device_bus)) {
          disabledSet.add(m.device_bus);
        }
      }
      profileDeviceBuses.set(config.profile_id, enabledSet);
      profileDisabledBuses.set(config.profile_id, disabledSet);
    });
  });

  // Every bus the profile declares gets a handle, wired into this session or
  // not. An unwired one renders muted and is the drag handle for adding it.
  profiles.forEach((profile) => {
    if (!activeProfileIds.has(profile.id)) return;
    const enabledSet = profileDeviceBuses.get(profile.id);
    const disabledSet = profileDisabledBuses.get(profile.id) ?? new Set<number>();
    for (const bus of profileBuses?.get(profile.id) ?? []) {
      if (!enabledSet?.has(bus.device_bus)) disabledSet.add(bus.device_bus);
    }
    profileDisabledBuses.set(profile.id, disabledSet);
  });

  // Column 1: Source nodes (profiles feeding sessions)
  // Sorted by output bus so edges don't cross
  const activeProfiles = profiles
    .filter((p) => activeProfileIds.has(p.id))
    .sort((a, b) => (profileOutputBus.get(a.id) ?? 0) - (profileOutputBus.get(b.id) ?? 0));
  let sourceY = START_Y;
  const pushSource = (id: string, data: SourceNodeData) => {
    nodes.push({ id: `source-${id}`, x: START_X, y: sourceY, data: { kind: "source", ...data } });
    sourceY += sourceHeight(data) + NODE_GAP;
  };
  activeProfiles.forEach((profile) => {
    const isRealtime = isRealtimeProfile(profile);
    const deviceBusSet = profileDeviceBuses.get(profile.id);
    const outputBuses = deviceBusSet ? [...deviceBusSet].sort((a, b) => a - b) : undefined;
    const disabledBusSet = profileDisabledBuses.get(profile.id);
    const disabledBuses = disabledBusSet && disabledBusSet.size > 0
      ? [...disabledBusSet].sort((a, b) => a - b)
      : undefined;

    const nodeData: SourceNodeData = {
      profileId: profile.id,
      profileName: profile.name,
      sourceType: profile.kind,
      isRealtime,
      isActive: true,
      outputBuses,
      disabledBuses,
    };

    pushSource(profile.id, nodeData);
  });

  // Column 1b: Buffer source nodes (any source ID that isn't an IOProfile)
  const profileIdSet = new Set(profiles.map((p) => p.id));
  const bufferSourceIds = [...activeProfileIds].filter(
    (id) => !profileIdSet.has(id)
  );
  bufferSourceIds.forEach((captureId) => {
    const info = captureInfoMap?.get(captureId);
    const nodeData: SourceNodeData = {
      profileId: captureId,
      profileName: info?.name ?? captureId,
      sourceType: "sqlite",
      isRealtime: false,
      isActive: true,
      captureName: info?.name,
      isPersistent: info?.persistent,
      captureCount: info?.count,
      captureKind: info?.captureKind,
    };
    pushSource(captureId, nodeData);
  });

  // Column 2: Session nodes + Column 3: Connected app nodes, a row each
  let sessionY = START_Y;
  let appBottom: number | undefined;
  sessions.forEach((session) => {
    // Collect input buses for this session. Sets, not arrays: two sources can
    // land on the same output bus, and a duplicate would give the session node
    // two handles sharing an id — which breaks drag-to-connect targeting.
    const inputBusSet = new Set<number>();
    const disabledInputBusSet = new Set<number>();
    session.source_profile_ids.forEach((profileId) => {
      const sourceConfig = session.broker_configs?.find((c) => c.profile_id === profileId);
      if (!sourceConfig) return;
      for (const m of sourceConfig.bus_mappings) {
        (m.enabled ? inputBusSet : disabledInputBusSet).add(m.output_bus);
      }
    });
    // An output bus carried by any source outranks a disabled mapping on it
    for (const bus of inputBusSet) disabledInputBusSet.delete(bus);
    const inputBuses = [...inputBusSet].sort((a, b) => a - b);
    const disabledInputBuses = [...disabledInputBusSet].sort((a, b) => a - b);

    // Build ordered app IDs for output handles
    const connectedAppIds = session.subscribers.map((l) => l.subscriber_id);

    const nodeData: SessionNodeData = {
      session,
      label: session.session_id,
      inputBuses: inputBuses.length > 0 ? inputBuses : undefined,
      disabledInputBuses: disabledInputBuses.length > 0 ? disabledInputBuses : undefined,
      connectedSubscriberIds: connectedAppIds.length > 0 ? connectedAppIds : undefined,
    };

    nodes.push({
      id: `session-${session.session_id}`,
      x: START_X + COLUMN_SPACING,
      y: sessionY,
      data: { kind: "session", ...nodeData },
    });

    // Create edges from sources to session — one edge per enabled bus mapping
    const running = session.state.type === "Running";
    const sourceStroke = { stroke: running ? "#a855f7" : "#6b7280", animated: running };
    session.source_profile_ids.forEach((profileId) => {
      const sourceConfig = session.broker_configs?.find((c) => c.profile_id === profileId);
      const enabledMappings = sourceConfig?.bus_mappings.filter((m) => m.enabled) ?? [];

      if (enabledMappings.length === 0) {
        // Fallback: single unlabelled edge when no mappings available
        edges.push({
          id: `edge-${profileId}-${session.session_id}`,
          source: `source-${profileId}`,
          target: `session-${session.session_id}`,
          data: { ...sourceStroke, curvature: DEFAULT_CURVATURE },
        });
        return;
      }

      for (const mapping of enabledMappings) {
        edges.push({
          id: `edge-${profileId}-${session.session_id}-b${mapping.device_bus}-b${mapping.output_bus}`,
          source: `source-${profileId}`,
          sourcePort: `out-bus${mapping.device_bus}`,
          target: `session-${session.session_id}`,
          targetPort: `in-bus${mapping.output_bus}`,
          data: { ...sourceStroke, curvature: INTERFACE_CURVATURE },
        });
      }
    });

    session.subscribers.forEach((listener, appIndex) => {
      const appName = listener.app_name || listener.subscriber_id;
      // The cosmetic display id + window live in the open-app roster; match by id
      // (instance_id == subscriber_id).
      const openApp = openApps?.find((a) => a.instance_id === listener.subscriber_id);

      const nodeData: AppNodeData = {
        appId: openApp?.display_id ?? listener.subscriber_id,
        appName,
        sessionId: session.session_id,
        isActive: listener.is_active,
        isConnected: true,
        registeredSecondsAgo: listener.registered_seconds_ago,
      };

      const nodeId = `app::${session.session_id}::${listener.subscriber_id}`;

      nodes.push({
        id: nodeId,
        x: START_X + COLUMN_SPACING * 2,
        y: sessionY + appIndex * APP_SPACING,
        data: { kind: "app", ...nodeData },
      });

      // Edge from session output handle to app
      edges.push({
        id: `edge-${session.session_id}::${listener.subscriber_id}`,
        source: `session-${session.session_id}`,
        sourcePort: `out-${appIndex}`,
        target: nodeId,
        targetPort: APP_INPUT_PORT,
        data: {
          stroke: listener.is_active && session.is_streaming ? "#22c55e" : "#6b7280",
          animated: session.state.type === "Running" && session.is_streaming && listener.is_active,
          curvature: DEFAULT_CURVATURE,
        },
      });
    });

    const apps = session.subscribers.length;
    const appsHeight = apps > 0 ? (apps - 1) * APP_SPACING + APP_HEIGHT : 0;
    if (apps > 0) appBottom = sessionY + appsHeight;
    sessionY += Math.max(sessionHeight(nodeData), appsHeight) + NODE_GAP;
  });

  // Column 3b: Unconnected app nodes — open session-aware app instances (across ALL
  // windows) that aren't attached to any session. Sourced from the Rust-owned roster,
  // so a session_id of null is the authoritative "unconnected" signal.
  if (openApps) {
    const unconnected = openApps.filter((a) => a.session_id == null);

    const unconnectedBaseY = appBottom === undefined ? START_Y : appBottom + NODE_GAP;

    unconnected.forEach((inst, i) => {
      const nodeData: AppNodeData = {
        appId: inst.display_id,
        appName: inst.app_name,
        isActive: false,
        isConnected: false,
      };

      nodes.push({
        id: `app::${inst.instance_id}`,
        x: START_X + COLUMN_SPACING * 2,
        y: unconnectedBaseY + i * APP_SPACING,
        data: { kind: "app", ...nodeData },
      });
    });
  }

  return { nodes, edges };
}

/** fitView padding as a fraction of the nodes' extent. */
export function calculateFitViewPadding(nodeCount: number): number {
  if (nodeCount <= 3) return 0.3;
  if (nodeCount <= 6) return 0.2;
  return 0.1;
}

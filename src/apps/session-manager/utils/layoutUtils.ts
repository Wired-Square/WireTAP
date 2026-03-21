// src/apps/session-manager/utils/layoutUtils.ts

import type { Edge } from "@xyflow/react";
import type { ActiveSessionInfo } from "../../../api/io";
import type { IOProfile } from "../../../hooks/useSettings";
import type { SourceNodeData } from "../nodes/SourceNode";
import type { SessionNodeData } from "../nodes/SessionNode";
import type { AppNodeData } from "../nodes/AppNode";
import type { InterfaceEdgeData } from "../edges/InterfaceEdge";

// Layout constants
const COLUMN_SPACING = 300;
const ROW_SPACING = 120;
const START_X = 50;
const START_Y = 50;

/** Session-aware panel IDs that should appear as app nodes */
const SESSION_AWARE_PANELS = new Set(["discovery", "decoder", "transmit", "query", "graph"]);

// Custom node type that allows our typed data
interface FlowNode<T = unknown> {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: T;
}

export interface SessionGraphData {
  nodes: FlowNode[];
  edges: Edge[];
}

/** Buffer metadata for source node display */
export interface BufferInfo {
  name: string;
  persistent: boolean;
  count: number;
  bufferType: string;
}

/**
 * Transform session data into React Flow nodes and edges.
 * @param bufferInfoMap Optional map of buffer_id → metadata for buffer source nodes.
 * @param openPanelIds IDs of currently open Dockview panels (used for unconnected app nodes).
 */
export function buildSessionGraph(
  sessions: ActiveSessionInfo[],
  profiles: IOProfile[],
  bufferInfoMap?: Map<string, BufferInfo>,
  openPanelIds?: string[],
  listenerIds?: Record<string, string>,
): SessionGraphData {
  const nodes: FlowNode[] = [];
  const edges: Edge[] = [];

  // Track which profiles are actively used by sessions
  const activeProfileIds = new Set<string>();
  sessions.forEach((session) => {
    session.sourceProfileIds.forEach((id) => activeProfileIds.add(id));
  });

  // Build a map of profileId → lowest outputBus for sorting source nodes
  // to match the vertical order of session input handles (avoids edge crossings)
  const profileOutputBus = new Map<string, number>();
  sessions.forEach((session) => {
    session.multiSourceConfigs?.forEach((config) => {
      const firstEnabled = config.busMappings.find((m) => m.enabled);
      if (firstEnabled && !profileOutputBus.has(config.profileId)) {
        profileOutputBus.set(config.profileId, firstEnabled.outputBus);
      }
    });
  });

  // Build profileId → Set<deviceBus> for output handles on source nodes
  const profileDeviceBuses = new Map<string, Set<number>>();
  const profileDisabledBuses = new Map<string, Set<number>>();
  sessions.forEach((session) => {
    session.multiSourceConfigs?.forEach((config) => {
      const enabledSet = profileDeviceBuses.get(config.profileId) ?? new Set();
      const disabledSet = profileDisabledBuses.get(config.profileId) ?? new Set();
      for (const m of config.busMappings) {
        if (m.enabled) {
          enabledSet.add(m.deviceBus);
          disabledSet.delete(m.deviceBus);
        } else if (!enabledSet.has(m.deviceBus)) {
          disabledSet.add(m.deviceBus);
        }
      }
      profileDeviceBuses.set(config.profileId, enabledSet);
      profileDisabledBuses.set(config.profileId, disabledSet);
    });
  });

  // Column 1: Source nodes (profiles feeding sessions)
  // Sorted by output bus so edges don't cross
  const activeProfiles = profiles
    .filter((p) => activeProfileIds.has(p.id))
    .sort((a, b) => (profileOutputBus.get(a.id) ?? 0) - (profileOutputBus.get(b.id) ?? 0));
  activeProfiles.forEach((profile, index) => {
    const isRealtime = ["gvret_tcp", "gvret_usb", "slcan", "socketcan", "gs_usb", "mqtt", "modbus_tcp", "serial", "framelink", "virtual"].includes(
      profile.kind
    );
    const deviceBusSet = profileDeviceBuses.get(profile.id);
    const outputBuses = deviceBusSet ? [...deviceBusSet].sort((a, b) => a - b) : undefined;
    const disabledBusSet = profileDisabledBuses.get(profile.id);
    const disabledBuses = disabledBusSet && disabledBusSet.size > 0
      ? [...disabledBusSet].sort((a, b) => a - b)
      : undefined;

    const nodeData: SourceNodeData = {
      profileId: profile.id,
      profileName: profile.name,
      deviceType: profile.kind,
      isRealtime,
      isActive: true,
      outputBuses,
      disabledBuses,
    };

    nodes.push({
      id: `source-${profile.id}`,
      type: "source",
      position: { x: START_X, y: START_Y + index * ROW_SPACING },
      data: nodeData,
    });
  });

  // Column 1b: Buffer source nodes (any source ID that isn't an IOProfile)
  const profileIdSet = new Set(profiles.map((p) => p.id));
  const bufferSourceIds = [...activeProfileIds].filter(
    (id) => !profileIdSet.has(id)
  );
  bufferSourceIds.forEach((bufferId, i) => {
    const index = activeProfiles.length + i;
    const info = bufferInfoMap?.get(bufferId);
    const nodeData: SourceNodeData = {
      profileId: bufferId,
      profileName: info?.name ?? bufferId,
      deviceType: "sqlite",
      isRealtime: false,
      isActive: true,
      bufferName: info?.name,
      isPersistent: info?.persistent,
      bufferCount: info?.count,
      bufferType: info?.bufferType,
    };
    nodes.push({
      id: `source-${bufferId}`,
      type: "source",
      position: { x: START_X, y: START_Y + index * ROW_SPACING },
      data: nodeData,
    });
  });

  // Track which app names already appear as connected apps (for unconnected app nodes)
  const connectedAppNames = new Set<string>();

  // Column 2: Session nodes + Column 3: Connected app nodes
  sessions.forEach((session, index) => {
    // Collect input buses for this session
    const inputBuses: number[] = [];
    const disabledInputBuses: number[] = [];
    session.sourceProfileIds.forEach((profileId) => {
      const sourceConfig = session.multiSourceConfigs?.find((c) => c.profileId === profileId);
      if (!sourceConfig) return;
      const enabledOutputBuses = new Set<number>();
      for (const m of sourceConfig.busMappings) {
        if (m.enabled) {
          inputBuses.push(m.outputBus);
          enabledOutputBuses.add(m.outputBus);
        }
      }
      for (const m of sourceConfig.busMappings) {
        if (!m.enabled && !enabledOutputBuses.has(m.outputBus)) {
          disabledInputBuses.push(m.outputBus);
        }
      }
    });

    // Build ordered app IDs for output handles
    const connectedAppIds = session.listeners.map((l) => l.listener_id);

    const nodeData: SessionNodeData = {
      session,
      label: session.sessionId,
      inputBuses: inputBuses.length > 0 ? inputBuses : undefined,
      disabledInputBuses: disabledInputBuses.length > 0 ? disabledInputBuses : undefined,
      connectedListenerIds: connectedAppIds.length > 0 ? connectedAppIds : undefined,
    };

    nodes.push({
      id: `session-${session.sessionId}`,
      type: "session",
      position: { x: START_X + COLUMN_SPACING, y: START_Y + index * ROW_SPACING },
      data: nodeData,
    });

    // Create edges from sources to session — one edge per enabled bus mapping
    session.sourceProfileIds.forEach((profileId) => {
      const sourceConfig = session.multiSourceConfigs?.find((c) => c.profileId === profileId);
      const enabledMappings = sourceConfig?.busMappings.filter((m) => m.enabled) ?? [];

      if (enabledMappings.length === 0) {
        // Fallback: single unlabelled edge when no mappings available
        edges.push({
          id: `edge-${profileId}-${session.sessionId}`,
          source: `source-${profileId}`,
          target: `session-${session.sessionId}`,
          type: "default",
          animated: session.state === "running",
          style: {
            stroke: session.state === "running" ? "#a855f7" : "#6b7280",
            strokeWidth: 2,
          },
        });
        return;
      }

      for (const mapping of enabledMappings) {
        edges.push({
          id: `edge-${profileId}-${session.sessionId}-b${mapping.deviceBus}-b${mapping.outputBus}`,
          source: `source-${profileId}`,
          sourceHandle: `out-bus${mapping.deviceBus}`,
          target: `session-${session.sessionId}`,
          targetHandle: `in-bus${mapping.outputBus}`,
          type: "interface",
          animated: session.state === "running",
          style: {
            stroke: session.state === "running" ? "#a855f7" : "#6b7280",
            strokeWidth: 2,
          },
          data: {
            sourceInterface: `bus${mapping.deviceBus}`,
            targetInterface: `bus${mapping.outputBus}`,
          } satisfies InterfaceEdgeData as InterfaceEdgeData & Record<string, unknown>,
        });
      }
    });

    // Column 3: Connected app nodes
    const sessionBaseY = START_Y + index * ROW_SPACING;

    session.listeners.forEach((listener, appIndex) => {
      const appName = listener.app_name || listener.listener_id;
      connectedAppNames.add(appName.toLowerCase());

      const nodeData: AppNodeData = {
        appId: listener.listener_id,
        appName,
        sessionId: session.sessionId,
        isActive: listener.is_active,
        isConnected: true,
        registeredSecondsAgo: listener.registered_seconds_ago,
      };

      const nodeId = `app::${session.sessionId}::${listener.listener_id}`;

      nodes.push({
        id: nodeId,
        type: "app",
        position: {
          x: START_X + COLUMN_SPACING * 2,
          y: sessionBaseY + appIndex * (ROW_SPACING * 0.6),
        },
        data: nodeData,
      });

      // Edge from session output handle to app
      edges.push({
        id: `edge-${session.sessionId}::${listener.listener_id}`,
        source: `session-${session.sessionId}`,
        sourceHandle: `out-${appIndex}`,
        target: nodeId,
        animated: session.state === "running" && session.isStreaming && listener.is_active,
        style: {
          stroke: listener.is_active && session.isStreaming ? "#22c55e" : "#6b7280",
          strokeWidth: 2,
        },
      });
    });
  });

  // Column 3b: Unconnected app nodes for open session-aware panels
  if (openPanelIds) {
    const unconnectedPanels = openPanelIds.filter(
      (id) => SESSION_AWARE_PANELS.has(id) && !connectedAppNames.has(id)
    );

    // Position below all connected apps
    const maxConnectedY = nodes
      .filter((n) => n.type === "app")
      .reduce((max, n) => Math.max(max, n.position.y), START_Y - ROW_SPACING * 0.6);
    const unconnectedBaseY = maxConnectedY + ROW_SPACING;

    unconnectedPanels.forEach((panelId, i) => {
      const nodeData: AppNodeData = {
        appId: listenerIds?.[panelId] ?? panelId,
        appName: panelId,
        isActive: false,
        isConnected: false,
      };

      nodes.push({
        id: `app::${panelId}`,
        type: "app",
        position: {
          x: START_X + COLUMN_SPACING * 2,
          y: unconnectedBaseY + i * (ROW_SPACING * 0.6),
        },
        data: nodeData,
      });
    });
  }

  return { nodes, edges };
}

/**
 * Calculate fitView padding as a ratio (ReactFlow convention).
 * 0.2 = 20% of bounding box added as whitespace around nodes.
 */
export function calculateFitViewPadding(nodeCount: number): number {
  if (nodeCount <= 3) return 0.3;
  if (nodeCount <= 6) return 0.2;
  return 0.1;
}

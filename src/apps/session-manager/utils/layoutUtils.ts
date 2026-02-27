// src/apps/session-manager/utils/layoutUtils.ts

import type { Edge } from "@xyflow/react";
import type { ActiveSessionInfo } from "../../../api/io";
import type { IOProfile } from "../../../hooks/useSettings";
import type { SourceNodeData } from "../nodes/SourceNode";
import type { SessionNodeData } from "../nodes/SessionNode";
import type { ListenerNodeData } from "../nodes/ListenerNode";
import type { InterfaceEdgeData } from "../edges/InterfaceEdge";

// Layout constants
const COLUMN_SPACING = 300;
const ROW_SPACING = 120;
const START_X = 50;
const START_Y = 50;

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

/**
 * Transform session data into React Flow nodes and edges.
 * @param bufferNames Optional map of buffer_id → display name for buffer source nodes.
 */
export function buildSessionGraph(
  sessions: ActiveSessionInfo[],
  profiles: IOProfile[],
  bufferNames?: Map<string, string>,
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

  // Column 1: Source nodes (profiles feeding sessions)
  // Sorted by output bus so edges don't cross
  const activeProfiles = profiles
    .filter((p) => activeProfileIds.has(p.id))
    .sort((a, b) => (profileOutputBus.get(a.id) ?? 0) - (profileOutputBus.get(b.id) ?? 0));
  activeProfiles.forEach((profile, index) => {
    const isRealtime = ["gvret_tcp", "gvret_usb", "slcan", "socketcan", "gs_usb", "mqtt", "modbus_tcp"].includes(
      profile.kind
    );

    const nodeData: SourceNodeData = {
      profileId: profile.id,
      profileName: profile.name,
      deviceType: profile.kind,
      isRealtime,
      isActive: true,
    };

    nodes.push({
      id: `source-${profile.id}`,
      type: "source",
      position: { x: START_X, y: START_Y + index * ROW_SPACING },
      data: nodeData,
    });
  });

  // Column 1b: Buffer source nodes (buffer IDs that aren't IOProfiles)
  const profileIdSet = new Set(profiles.map((p) => p.id));
  const bufferSourceIds = [...activeProfileIds].filter(
    (id) => !profileIdSet.has(id) && /^buf_\d+$/.test(id)
  );
  bufferSourceIds.forEach((bufferId, i) => {
    const index = activeProfiles.length + i;
    const nodeData: SourceNodeData = {
      profileId: bufferId,
      profileName: bufferNames?.get(bufferId) ?? bufferId,
      deviceType: "sqlite",
      isRealtime: false,
      isActive: true,
    };
    nodes.push({
      id: `source-${bufferId}`,
      type: "source",
      position: { x: START_X, y: START_Y + index * ROW_SPACING },
      data: nodeData,
    });
  });

  // Column 2: Session nodes
  sessions.forEach((session, index) => {
    // Collect all mapped input interfaces for this session (one per source mapping)
    const inputInterfaces: string[] = [];
    session.sourceProfileIds.forEach((profileId) => {
      const sourceConfig = session.multiSourceConfigs?.find((c) => c.profileId === profileId);
      const enabledMappings = sourceConfig?.busMappings.filter((m) => m.enabled) ?? [];
      for (const m of enabledMappings) {
        inputInterfaces.push(`bus${m.outputBus}`);
      }
    });

    const nodeData: SessionNodeData = {
      session,
      label: session.sessionId,
      inputInterfaces: inputInterfaces.length > 0 ? inputInterfaces : undefined,
    };

    nodes.push({
      id: `session-${session.sessionId}`,
      type: "session",
      position: { x: START_X + COLUMN_SPACING, y: START_Y + index * ROW_SPACING },
      data: nodeData,
    });

    // Create edges from sources to session, with interface labels
    session.sourceProfileIds.forEach((profileId) => {
      // Look up interface IDs from multi-source configs
      const sourceConfig = session.multiSourceConfigs?.find((c) => c.profileId === profileId);
      const enabledMappings = sourceConfig?.busMappings.filter((m) => m.enabled) ?? [];
      // Source label: device bus (e.g., "bus0")
      const sourceLabel = enabledMappings.length > 0
        ? enabledMappings.map((m) => `bus${m.deviceBus}`).join(", ")
        : undefined;
      // Target label: mapped output bus (e.g., "bus0", "bus1")
      const targetLabel = enabledMappings.length > 0
        ? enabledMappings.map((m) => `bus${m.outputBus}`).join(", ")
        : undefined;
      // Target handle ID — connects to the matching input handle on the session node
      const targetHandleId = enabledMappings.length > 0
        ? `in-bus${enabledMappings[0].outputBus}`
        : undefined;

      edges.push({
        id: `edge-${profileId}-${session.sessionId}`,
        source: `source-${profileId}`,
        target: `session-${session.sessionId}`,
        targetHandle: targetHandleId,
        type: sourceLabel ? "interface" : "smoothstep",
        animated: session.state === "running",
        style: {
          stroke: session.state === "running" ? "#a855f7" : "#6b7280",
          strokeWidth: 2,
        },
        data: {
          sourceInterface: sourceLabel ?? "",
          targetInterface: targetLabel ?? "",
        } satisfies InterfaceEdgeData as InterfaceEdgeData & Record<string, unknown>,
      });
    });
  });

  // Column 3: Individual listener nodes
  sessions.forEach((session, sessionIndex) => {
    const sessionBaseY = START_Y + sessionIndex * ROW_SPACING;

    session.listeners.forEach((listener, listenerIndex) => {
      const nodeData: ListenerNodeData = {
        listenerId: listener.listener_id,
        appName: listener.app_name || listener.listener_id,
        sessionId: session.sessionId,
        isActive: listener.is_active,
        registeredSecondsAgo: listener.registered_seconds_ago,
      };

      const nodeId = `listener::${session.sessionId}::${listener.listener_id}`;

      nodes.push({
        id: nodeId,
        type: "listener",
        position: {
          x: START_X + COLUMN_SPACING * 2,
          y: sessionBaseY + listenerIndex * (ROW_SPACING * 0.6),
        },
        data: nodeData,
      });

      edges.push({
        id: `edge-${session.sessionId}::${listener.listener_id}`,
        source: `session-${session.sessionId}`,
        target: nodeId,
        animated: session.state === "running" && session.isStreaming && listener.is_active,
        style: {
          stroke: listener.is_active && session.isStreaming ? "#22c55e" : "#6b7280",
          strokeWidth: 2,
        },
      });
    });
  });

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

// src/apps/session-manager/utils/layoutUtils.ts

import type { Edge } from "@xyflow/react";
import type { ActiveSessionInfo } from "../../../api/io";
import type { IOProfile } from "../../../hooks/useSettings";
import type { SourceNodeData } from "../nodes/SourceNode";
import type { SessionNodeData } from "../nodes/SessionNode";
import type { ListenerNodeData } from "../nodes/ListenerNode";

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
 * Transform session data into React Flow nodes and edges
 */
export function buildSessionGraph(
  sessions: ActiveSessionInfo[],
  profiles: IOProfile[]
): SessionGraphData {
  const nodes: FlowNode[] = [];
  const edges: Edge[] = [];

  // Track which profiles are actively used by sessions
  const activeProfileIds = new Set<string>();
  sessions.forEach((session) => {
    session.sourceProfileIds.forEach((id) => activeProfileIds.add(id));
  });

  // Column 1: Source nodes (profiles feeding sessions)
  // Only show profiles that are actively used
  const activeProfiles = profiles.filter((p) => activeProfileIds.has(p.id));
  activeProfiles.forEach((profile, index) => {
    const isRealtime = ["gvret_tcp", "gvret_usb", "slcan", "socketcan", "gs_usb", "mqtt"].includes(
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

  // Column 2: Session nodes
  sessions.forEach((session, index) => {
    const nodeData: SessionNodeData = {
      session,
      label: session.sessionId,
    };

    nodes.push({
      id: `session-${session.sessionId}`,
      type: "session",
      position: { x: START_X + COLUMN_SPACING, y: START_Y + index * ROW_SPACING },
      data: nodeData,
    });

    // Create edges from sources to session
    session.sourceProfileIds.forEach((profileId) => {
      edges.push({
        id: `edge-${profileId}-${session.sessionId}`,
        source: `source-${profileId}`,
        target: `session-${session.sessionId}`,
        animated: session.state === "running",
        style: {
          stroke: session.state === "running" ? "#a855f7" : "#6b7280",
          strokeWidth: 2,
        },
      });
    });
  });

  // Column 3: Individual listener nodes
  sessions.forEach((session, sessionIndex) => {
    const sessionBaseY = START_Y + sessionIndex * ROW_SPACING;

    session.listeners.forEach((listener, listenerIndex) => {
      const nodeData: ListenerNodeData = {
        listenerId: listener.listener_id,
        appName: listener.listener_id,
        sessionId: session.sessionId,
        isOwner: listener.is_owner,
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

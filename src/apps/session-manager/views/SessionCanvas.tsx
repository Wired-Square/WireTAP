// src/apps/session-manager/views/SessionCanvas.tsx

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type NodeTypes,
  type EdgeTypes,
  type Connection,
  type Edge,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import SourceNode from "../nodes/SourceNode";
import SessionNode from "../nodes/SessionNode";
import AppNode from "../nodes/AppNode";
import InterfaceEdge from "../edges/InterfaceEdge";
import { buildSessionGraph, calculateFitViewPadding, type BufferInfo } from "../utils/layoutUtils";
import { useSessionManagerStore } from "../stores/sessionManagerStore";
import type { ActiveSessionInfo } from "../../../api/io";
import type { IOProfile } from "../../../hooks/useSettings";
import { listBuffers } from "../../../api/buffer";

// Register custom node and edge types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes: NodeTypes = {
  source: SourceNode as any,
  session: SessionNode as any,
  app: AppNode as any,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const edgeTypes: EdgeTypes = {
  interface: InterfaceEdge as any,
};

interface SessionCanvasProps {
  sessions: ActiveSessionInfo[];
  profiles: IOProfile[];
  openPanelIds?: string[];
  listenerIds?: Record<string, string>;
  onEnableBusMapping?: (sessionId: string, profileId: string, deviceBus: number, outputBus: number) => void;
  onCreateBusMapping?: (sessionId: string, profileId: string, deviceBus: number, newOutputBus: number) => void;
  onConnectAppToSession?: (sessionId: string, appName: string) => void;
}

export default function SessionCanvas({
  sessions,
  profiles,
  openPanelIds,
  listenerIds,
  onEnableBusMapping,
  onCreateBusMapping,
  onConnectAppToSession,
}: SessionCanvasProps) {
  const { fitView } = useReactFlow();
  const setSelectedNode = useSessionManagerStore((s) => s.setSelectedNode);

  // Fetch buffer metadata for source node display
  const [bufferInfoMap, setBufferInfoMap] = useState<Map<string, BufferInfo>>(new Map());
  useEffect(() => {
    listBuffers()
      .then((buffers) => {
        const map = new Map<string, BufferInfo>();
        for (const b of buffers) {
          map.set(b.id, {
            name: b.name,
            persistent: b.persistent,
            count: b.count,
            bufferType: b.buffer_type,
          });
        }
        setBufferInfoMap(map);
      })
      .catch(console.error);
  }, [sessions]);

  const graphData = useMemo(
    () => buildSessionGraph(sessions, profiles, bufferInfoMap, openPanelIds, listenerIds),
    [sessions, profiles, bufferInfoMap, openPanelIds, listenerIds]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(graphData.nodes as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphData.edges);

  // Update nodes and edges when data changes. When topology is unchanged
  // (same node IDs), update data in-place to preserve user-dragged positions
  // and avoid ReactFlow re-measuring/resetting the viewport.
  useEffect(() => {
    setNodes((prev) => {
      const newIds = new Set(graphData.nodes.map((n) => n.id));
      const topologyChanged = prev.length !== graphData.nodes.length || !prev.every((n) => newIds.has(n.id));
      if (topologyChanged) {
        return graphData.nodes as Node[];
      }
      // Topology same — merge updated data into existing nodes (preserves positions)
      const newDataMap = new Map(graphData.nodes.map((n) => [n.id, n.data as Record<string, unknown>]));
      return prev.map((n) => {
        const newData = newDataMap.get(n.id);
        return newData ? { ...n, data: newData } as Node : n;
      });
    });
    setEdges((prev) => {
      const newEdgeIds = new Set(graphData.edges.map((e) => e.id));
      if (prev.length === graphData.edges.length && prev.every((e) => newEdgeIds.has(e.id))) {
        // Update edge styles (animated, stroke colour) even when topology is same
        const newEdgeMap = new Map(graphData.edges.map((e) => [e.id, e]));
        return prev.map((e) => {
          const updated = newEdgeMap.get(e.id);
          return updated ? { ...e, style: updated.style, animated: updated.animated } : e;
        });
      }
      return graphData.edges;
    });
  }, [graphData, setNodes, setEdges]);

  // Fit view once on mount. Delayed because the conditionally-rendered
  // container needs a frame to get its dimensions.
  const fitViewRef = useRef(fitView);
  fitViewRef.current = fitView;
  useEffect(() => {
    const id = setTimeout(() => {
      fitViewRef.current({ padding: calculateFitViewPadding(nodes.length), duration: 200 });
    }, 300);
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      setSelectedNode({ id: node.id, type: node.type as "source" | "session" | "app" });
    },
    [setSelectedNode]
  );

  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      setSelectedNode({ id: edge.id, type: "edge" });
    },
    [setSelectedNode]
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  // Handle drag-to-connect: re-enable a disabled bus mapping, create new mapping,
  // or connect an app to a session
  const onConnect = useCallback(
    (connection: Connection) => {
      const { source, sourceHandle, target, targetHandle } = connection;
      if (!source || !target) return;

      // Case 1: Source → Session (bus mapping)
      if (source.startsWith("source-") && target.startsWith("session-")) {
        const profileId = source.replace(/^source-/, "");
        const sessionId = target.replace(/^session-/, "");
        const deviceBusMatch = sourceHandle?.match(/^out-bus(\d+)$/);
        const outputBusMatch = targetHandle?.match(/^in-bus(\d+)$/);
        if (!deviceBusMatch || !outputBusMatch) return;

        const deviceBus = parseInt(deviceBusMatch[1], 10);
        const outputBus = parseInt(outputBusMatch[1], 10);

        // Check if this is re-enabling an existing disabled mapping
        const session = sessions.find((s) => s.sessionId === sessionId);
        const config = session?.multiSourceConfigs?.find((c) => c.profileId === profileId);
        const isDisabledMapping = config?.busMappings.some(
          (m) => m.deviceBus === deviceBus && m.outputBus === outputBus && !m.enabled
        );

        if (isDisabledMapping && onEnableBusMapping) {
          onEnableBusMapping(sessionId, profileId, deviceBus, outputBus);
        } else if (onCreateBusMapping) {
          onCreateBusMapping(sessionId, profileId, deviceBus, outputBus);
        }
        return;
      }

      // Case 2: Session → App (connect unconnected app to session)
      if (source.startsWith("session-") && target.startsWith("app::")) {
        if (!onConnectAppToSession) return;
        const sessionId = source.replace(/^session-/, "");
        const appName = target.replace(/^app::/, "");
        onConnectAppToSession(sessionId, appName);
      }
    },
    [sessions, onEnableBusMapping, onCreateBusMapping, onConnectAppToSession]
  );

  // Validate connections: source→session bus mappings or session→unconnected app
  const isValidConnection = useCallback(
    (connection: Edge | Connection) => {
      const { source, target, sourceHandle, targetHandle } = connection;

      // Case 1: Source → Session
      if (source?.startsWith("source-") && target?.startsWith("session-")) {
        if (!sourceHandle?.startsWith("out-bus") || !targetHandle?.startsWith("in-bus")) return false;

        const profileId = source.replace(/^source-/, "");
        const sessionId = target.replace(/^session-/, "");
        const deviceBusMatch = sourceHandle.match(/^out-bus(\d+)$/);
        const outputBusMatch = targetHandle.match(/^in-bus(\d+)$/);
        if (!deviceBusMatch || !outputBusMatch) return false;

        const deviceBus = parseInt(deviceBusMatch[1], 10);
        const outputBus = parseInt(outputBusMatch[1], 10);

        const session = sessions.find((s) => s.sessionId === sessionId);
        const config = session?.multiSourceConfigs?.find((c) => c.profileId === profileId);

        // Allow re-enabling disabled mappings
        if (config?.busMappings.some((m) => m.deviceBus === deviceBus && m.outputBus === outputBus && !m.enabled)) {
          return true;
        }

        // Allow creating new mappings (bus not already mapped)
        if (config && !config.busMappings.some((m) => m.deviceBus === deviceBus && m.outputBus === outputBus && m.enabled)) {
          return true;
        }

        // Also allow if source is connected to this session but this specific bus combo is new
        if (session?.sourceProfileIds.includes(profileId)) {
          return true;
        }

        return false;
      }

      // Case 2: Session → Unconnected app
      if (source?.startsWith("session-") && target?.startsWith("app::")) {
        return true;
      }

      return false;
    },
    [sessions]
  );

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{ type: "default" }}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--text-muted)"
          style={{ opacity: 0.3 }}
        />
        <Controls
          showInteractive={false}
          className="!bg-[var(--bg-surface)] !border-[color:var(--border-default)] !shadow-lg [&_button]:!bg-[var(--bg-surface)] [&_button]:!border-[color:var(--border-default)] [&_button]:!fill-[var(--text-primary)] [&_button:hover]:!bg-[var(--bg-hover)] [&_svg]:!fill-[var(--text-primary)]"
        />
        <MiniMap
          nodeColor={(node) => {
            switch (node.type) {
              case "source": return "#a855f7";
              case "session": return "#06b6d4";
              case "app": return "#22c55e";
              default: return "#6b7280";
            }
          }}
          maskColor="rgba(0, 0, 0, 0.7)"
          className="!bg-[var(--bg-surface)] !border-[color:var(--border-default)]"
        />
      </ReactFlow>
    </div>
  );
}

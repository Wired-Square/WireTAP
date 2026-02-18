// src/apps/session-manager/views/SessionCanvas.tsx

import { useCallback, useEffect, useMemo, useRef } from "react";
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
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import SourceNode from "../nodes/SourceNode";
import SessionNode from "../nodes/SessionNode";
import ListenerNode from "../nodes/ListenerNode";
import { buildSessionGraph, calculateFitViewPadding } from "../utils/layoutUtils";
import { useSessionManagerStore } from "../stores/sessionManagerStore";
import type { ActiveSessionInfo } from "../../../api/io";
import type { IOProfile } from "../../../hooks/useSettings";

// Register custom node types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes: NodeTypes = {
  source: SourceNode as any,
  session: SessionNode as any,
  listener: ListenerNode as any,
};

interface SessionCanvasProps {
  sessions: ActiveSessionInfo[];
  profiles: IOProfile[];
}

export default function SessionCanvas({ sessions, profiles }: SessionCanvasProps) {
  const { fitView } = useReactFlow();
  const setSelectedNode = useSessionManagerStore((s) => s.setSelectedNode);

  const graphData = useMemo(
    () => buildSessionGraph(sessions, profiles),
    [sessions, profiles]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(graphData.nodes as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphData.edges);

  // Only replace nodes/edges when the topology changes (sessions added/removed).
  // Returning the same reference on auto-refresh prevents ReactFlow from
  // re-measuring nodes and resetting the viewport. Live session data is still
  // available in the detail panel which reads directly from the sessions prop.
  useEffect(() => {
    setNodes((prev) => {
      const newIds = new Set(graphData.nodes.map((n) => n.id));
      if (prev.length === graphData.nodes.length && prev.every((n) => newIds.has(n.id))) {
        return prev;
      }
      return graphData.nodes as Node[];
    });
    setEdges((prev) => {
      if (prev.length === graphData.edges.length) return prev;
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
      setSelectedNode({ id: node.id, type: node.type as "source" | "session" | "listener" });
    },
    [setSelectedNode]
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{ type: "smoothstep" }}
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
          className="!bg-[var(--bg-surface)] !border-[color:var(--border-default)] !shadow-lg"
        />
        <MiniMap
          nodeColor={(node) => {
            switch (node.type) {
              case "source": return "#a855f7";
              case "session": return "#06b6d4";
              case "listener": return "#22c55e";
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

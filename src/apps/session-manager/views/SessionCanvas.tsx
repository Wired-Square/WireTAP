// src/apps/session-manager/views/SessionCanvas.tsx

import { useCallback, useEffect, useMemo } from "react";
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

  // Build graph from session data
  const graphData = useMemo(
    () => buildSessionGraph(sessions, profiles),
    [sessions, profiles]
  );

  // Cast to Node[] for React Flow compatibility
  const [nodes, setNodes, onNodesChange] = useNodesState(graphData.nodes as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphData.edges);

  // Update nodes/edges when graph data changes
  useEffect(() => {
    setNodes(graphData.nodes as Node[]);
    setEdges(graphData.edges);
  }, [graphData, setNodes, setEdges]);

  // Fit view when nodes change significantly
  useEffect(() => {
    if (nodes.length > 0) {
      const timeoutId = setTimeout(() => {
        fitView({ padding: calculateFitViewPadding(nodes.length), duration: 200 });
      }, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [nodes.length, fitView]);

  // Handle node selection
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const nodeType = node.type as "source" | "session" | "listener";
      setSelectedNode({ id: node.id, type: nodeType });
    },
    [setSelectedNode]
  );

  // Handle background click to deselect
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
        fitView
        fitViewOptions={{ padding: calculateFitViewPadding(nodes.length) }}
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{
          type: "smoothstep",
        }}
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
              case "source":
                return "#a855f7"; // purple
              case "session":
                return "#06b6d4"; // cyan
              case "listener":
                return "#22c55e"; // green
              default:
                return "#6b7280";
            }
          }}
          maskColor="rgba(0, 0, 0, 0.7)"
          className="!bg-[var(--bg-surface)] !border-[color:var(--border-default)]"
        />
      </ReactFlow>
    </div>
  );
}

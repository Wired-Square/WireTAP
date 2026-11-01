// src/apps/session-manager/views/SessionCanvas.tsx

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useCanvas } from "@wired-square/canvas/react";
import type { Point } from "@wired-square/canvas/core";
import "@wired-square/canvas/canvas.css";
import "./sessionCanvas.css";

import SourceNode from "../nodes/SourceNode";
import SessionNode from "../nodes/SessionNode";
import AppNode from "../nodes/AppNode";
import InterfaceEdge, { type InterfaceEdgeData } from "../edges/InterfaceEdge";
import { buildSessionGraph, calculateFitViewPadding, type CaptureInfo, type GraphNode } from "../utils/layoutUtils";
import { resolveConnection } from "../utils/graphConnections";
import { forgetGone, placeDragged, type DraggedPositions } from "../utils/draggedPositions";
import { useProfileBusStore } from "../../../stores/profileBusStore";
import { useSessionManagerStore } from "../stores/sessionManagerStore";
import type { ActiveSessionInfo, AppInstanceInfo } from "../../../api/io";
import type { IOProfile } from "../../../hooks/useSettings";
import { listCaptures } from "../../../api/capture";

const MINIMAP_COLOURS: Record<GraphNode["data"]["kind"], string> = {
  source: "#a855f7",
  session: "#06b6d4",
  app: "#22c55e",
};

function renderNode(node: GraphNode, selected: boolean) {
  const { data } = node;
  switch (data.kind) {
    case "source": return <SourceNode data={data} selected={selected} />;
    case "session": return <SessionNode data={data} selected={selected} />;
    case "app": return <AppNode data={data} selected={selected} />;
  }
}

interface SessionCanvasProps {
  sessions: ActiveSessionInfo[];
  profiles: IOProfile[];
  openApps?: AppInstanceInfo[];
  onEnableBusMapping?: (sessionId: string, profileId: string, deviceBus: number, outputBus: number) => void;
  onCreateBusMapping?: (sessionId: string, profileId: string, deviceBus: number, newOutputBus: number) => void;
  onConnectAppToSession?: (sessionId: string, appName: string) => void;
}

export default function SessionCanvas({
  sessions,
  profiles,
  openApps,
  onEnableBusMapping,
  onCreateBusMapping,
  onConnectAppToSession,
}: SessionCanvasProps) {
  const canvas = useCanvas();
  const selectedId = useSessionManagerStore((s) => s.selectedNode?.id);
  const setSelectedNode = useSessionManagerStore((s) => s.setSelectedNode);

  // Fetch capture metadata for source node display
  const [captureInfoMap, setCaptureInfoMap] = useState<Map<string, CaptureInfo>>(new Map());
  useEffect(() => {
    listCaptures()
      .then((captures) => {
        const map = new Map<string, CaptureInfo>();
        for (const b of captures) {
          map.set(b.id, {
            name: b.name,
            persistent: b.persistent,
            count: b.count,
            captureKind: b.kind,
          });
        }
        setCaptureInfoMap(map);
      })
      .catch(console.error);
  }, [sessions]);

  // Every bus each profile declares — drives the spare ports for buses not
  // yet wired into a session.
  const profileBuses = useProfileBusStore((s) => s.mappings);

  const graphData = useMemo(
    () => buildSessionGraph(sessions, profiles, captureInfoMap, openApps, profileBuses),
    [sessions, profiles, captureInfoMap, openApps, profileBuses]
  );

  const [dragged, setDragged] = useState<DraggedPositions>(new Map());
  useEffect(() => setDragged((prev) => forgetGone(prev, graphData.nodes)), [graphData.nodes]);
  const nodes = useMemo(() => placeDragged(graphData.nodes, dragged), [graphData.nodes, dragged]);
  const onNodeDragEnd = (node: GraphNode, position: Point) => setDragged((prev) => new Map(prev).set(node.id, position));

  // The canvas fits the first nodes itself; refit when the count changes after that.
  const lastCount = useRef(0);
  useEffect(() => {
    const previous = lastCount.current;
    lastCount.current = nodes.length;
    if (previous > 0 && previous !== nodes.length) {
      void canvas?.fitView({ padding: calculateFitViewPadding(nodes.length), duration: 200 });
    }
  }, [canvas, nodes.length]);

  const onConnect = (
    source: string,
    target: string,
    { sourcePort, targetPort }: { sourcePort: string | undefined; targetPort: string | undefined }
  ) => {
    const connection = resolveConnection(sessions, source, sourcePort, target, targetPort);
    if (connection?.kind === "bus") {
      const { sessionId, profileId, deviceBus, outputBus } = connection;
      (connection.reenable ? onEnableBusMapping : onCreateBusMapping)?.(sessionId, profileId, deviceBus, outputBus);
    } else if (connection?.kind === "app") {
      const appName = openApps?.find((a) => a.instance_id === connection.instanceId)?.app_name ?? connection.instanceId;
      onConnectAppToSession?.(connection.sessionId, appName);
    }
  };

  return (
    <Canvas<GraphNode["data"], InterfaceEdgeData>
      className="session-canvas"
      nodes={nodes}
      edges={graphData.edges}
      node={(node) => renderNode(node, node.id === selectedId)}
      edge={(edge, geometry) => <InterfaceEdge data={edge.data} geometry={geometry} />}
      onNodeClick={(node) => setSelectedNode({ id: node.id, type: node.data.kind })}
      onEdgeClick={(edge) => setSelectedNode({ id: edge.id, type: "edge" })}
      onPaneClick={() => setSelectedNode(null)}
      onNodeDragEnd={onNodeDragEnd}
      onConnect={onConnect}
      isValidConnection={(...ends) => resolveConnection(sessions, ...ends) !== undefined}
      connectionRadius={20}
      fitPadding={calculateFitViewPadding(nodes.length)}
      minZoom={0.1}
      maxZoom={2}
      background={{ gap: 20, size: 1 }}
      controls
      minimap={{ nodeColour: (node) => MINIMAP_COLOURS[node.data.kind] }}
    />
  );
}

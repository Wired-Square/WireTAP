// src/apps/session-manager/views/SessionCanvas.tsx

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useCanvas } from "@wired-square/canvas/react";
import type { Point } from "@wired-square/canvas/core";
import "@wired-square/canvas/canvas.css";
import "./sessionCanvas.css";

import SourceNode from "../nodes/SourceNode";
import SessionNode from "../nodes/SessionNode";
import AppNode from "../nodes/AppNode";
import InterfaceEdge, { type InterfaceEdgeData } from "../edges/InterfaceEdge";
import { buildSessionGraph, calculateFitViewPadding, type CaptureInfo, type GraphNode } from "../utils/layoutUtils";
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

  // Every bus each profile declares — drives the spare handles for buses not
  // yet wired into a session.
  const profileBuses = useProfileBusStore((s) => s.mappings);

  const graphData = useMemo(
    () => buildSessionGraph(sessions, profiles, captureInfoMap, openApps, profileBuses),
    [sessions, profiles, captureInfoMap, openApps, profileBuses]
  );

  // Dragged positions hold until the set of nodes changes, then the layout's return.
  const topology = useMemo(() => graphData.nodes.map((n) => n.id).sort().join("\n"), [graphData.nodes]);
  const [dragged, setDragged] = useState({ topology, positions: new Map<string, Point>() });
  const nodes = useMemo(() => {
    if (dragged.topology !== topology) return graphData.nodes;
    return graphData.nodes.map((n) => {
      const position = dragged.positions.get(n.id);
      return position ? { ...n, ...position } : n;
    });
  }, [graphData.nodes, topology, dragged]);

  const onNodeDragEnd = (node: GraphNode, position: Point) =>
    setDragged((prev) => ({
      topology,
      positions: new Map(prev.topology === topology ? prev.positions : []).set(node.id, position),
    }));

  // The canvas fits the first nodes itself; refit when the count changes after that.
  const lastCount = useRef(0);
  useEffect(() => {
    const previous = lastCount.current;
    lastCount.current = nodes.length;
    if (previous > 0 && previous !== nodes.length) {
      void canvas?.fitView({ padding: calculateFitViewPadding(nodes.length), duration: 200 });
    }
  }, [canvas, nodes.length]);

  // Handle drag-to-connect: re-enable a disabled bus mapping, create new mapping,
  // or connect an app to a session
  const onConnect = useCallback(
    (
      source: string,
      target: string,
      { sourcePort, targetPort }: { sourcePort: string | undefined; targetPort: string | undefined }
    ) => {

      // Case 1: Source → Session (bus mapping)
      if (source.startsWith("source-") && target.startsWith("session-")) {
        const profileId = source.replace(/^source-/, "");
        const sessionId = target.replace(/^session-/, "");
        const deviceBusMatch = sourcePort?.match(/^out-bus(\d+)$/);
        const outputBusMatch = targetPort?.match(/^in-bus(\d+)$/);
        if (!deviceBusMatch || !outputBusMatch) return;

        const deviceBus = parseInt(deviceBusMatch[1], 10);
        const outputBus = parseInt(outputBusMatch[1], 10);

        // Check if this is re-enabling an existing disabled mapping
        const session = sessions.find((s) => s.session_id === sessionId);
        const config = session?.broker_configs?.find((c) => c.profile_id === profileId);
        const isDisabledMapping = config?.bus_mappings.some(
          (m) => m.device_bus === deviceBus && m.output_bus === outputBus && !m.enabled
        );

        if (isDisabledMapping && onEnableBusMapping) {
          onEnableBusMapping(sessionId, profileId, deviceBus, outputBus);
        } else if (onCreateBusMapping) {
          onCreateBusMapping(sessionId, profileId, deviceBus, outputBus);
        }
        return;
      }

      // Case 2: Session → App (connect unconnected app to session). The node id is
      // `app::<instanceId>`; resolve back to the app type name for the join request.
      if (source.startsWith("session-") && target.startsWith("app::")) {
        if (!onConnectAppToSession) return;
        const sessionId = source.replace(/^session-/, "");
        const instanceId = target.replace(/^app::/, "");
        const appName = openApps?.find((a) => a.instance_id === instanceId)?.app_name ?? instanceId;
        onConnectAppToSession(sessionId, appName);
      }
    },
    [sessions, openApps, onEnableBusMapping, onCreateBusMapping, onConnectAppToSession]
  );

  // Validate connections: source→session bus mappings or session→unconnected app
  const isValidConnection = useCallback(
    (source: string, sourcePort: string | undefined, target: string, targetPort: string | undefined) => {
      // Case 1: Source → Session
      if (source.startsWith("source-") && target.startsWith("session-")) {
        const profileId = source.replace(/^source-/, "");
        const sessionId = target.replace(/^session-/, "");
        const deviceBusMatch = sourcePort?.match(/^out-bus(\d+)$/);
        const outputBusMatch = targetPort?.match(/^in-bus(\d+)$/);
        if (!deviceBusMatch || !outputBusMatch) return false;

        const deviceBus = parseInt(deviceBusMatch[1], 10);
        const outputBus = parseInt(outputBusMatch[1], 10);

        const session = sessions.find((s) => s.session_id === sessionId);
        const config = session?.broker_configs?.find((c) => c.profile_id === profileId);

        // Two sources on one output bus merge into an indistinguishable stream,
        // and Rust's transmit routing gives the bus to whichever source was
        // added last. Refuse the drop rather than create that.
        const takenByOther = session?.broker_configs?.some(
          (c) => c.profile_id !== profileId &&
                 c.bus_mappings.some((m) => m.enabled && m.output_bus === outputBus)
        );
        if (takenByOther) return false;

        // Allow re-enabling disabled mappings
        if (config?.bus_mappings.some((m) => m.device_bus === deviceBus && m.output_bus === outputBus && !m.enabled)) {
          return true;
        }

        // Allow creating new mappings (bus not already mapped)
        if (config && !config.bus_mappings.some((m) => m.device_bus === deviceBus && m.output_bus === outputBus && m.enabled)) {
          return true;
        }

        // Also allow if source is connected to this session but this specific bus combo is new
        if (session?.source_profile_ids.includes(profileId)) {
          return true;
        }

        return false;
      }

      // Case 2: Session → Unconnected app
      if (source.startsWith("session-") && target.startsWith("app::")) {
        return true;
      }

      return false;
    },
    [sessions]
  );

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
      isValidConnection={isValidConnection}
      minZoom={0.1}
      maxZoom={2}
      background={{ gap: 20, size: 1 }}
      controls
      minimap={{ nodeColour: (node) => MINIMAP_COLOURS[node.data.kind] }}
    />
  );
}

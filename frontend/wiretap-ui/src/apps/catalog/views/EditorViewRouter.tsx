// ui/src/apps/catalog/views/EditorViewRouter.tsx

import React from "react";
import type { TomlNode } from "../types";
import CANFrameView, { CANFrameViewProps } from "./CANFrameView";
import ChecksumView, { ChecksumViewProps } from "./ChecksumView";
import MetaView, { MetaViewProps } from "./MetaView";
import ModbusFrameView, { ModbusFrameViewProps } from "./ModbusFrameView";
import SerialFrameView, { SerialFrameViewProps } from "./SerialFrameView";
import MuxView, { MuxViewProps } from "./MuxView";
import MuxCaseView, { MuxCaseViewProps } from "./MuxCaseView";
import NodeView, { NodeViewProps } from "./NodeView";
import SignalView, { SignalViewProps } from "./SignalView";
import GenericChildrenView, { GenericChildrenViewProps } from "./GenericChildrenView";

export type EditorViewRouterProps = {
  selectedNode: TomlNode;

  // Migrated views (props provided by CatalogEditor)
  canFrameProps: CANFrameViewProps;
  checksumProps: Omit<ChecksumViewProps, "selectedNode">;
  metaProps: MetaViewProps;
  modbusFrameProps: Omit<ModbusFrameViewProps, "selectedNode">;
  serialFrameProps: Omit<SerialFrameViewProps, "selectedNode">;
  muxProps: MuxViewProps;
  muxCaseProps: MuxCaseViewProps;
  nodeProps: NodeViewProps;
  signalProps: SignalViewProps;
  genericChildrenProps: GenericChildrenViewProps;

  // For node types not yet migrated
  fallback: React.ReactNode;
};

// Router handles migrated views. Everything else should render via `fallback`.
export default function EditorViewRouter({
  selectedNode,
  canFrameProps,
  checksumProps,
  metaProps,
  modbusFrameProps,
  serialFrameProps,
  muxProps,
  muxCaseProps,
  nodeProps,
  signalProps,
  genericChildrenProps,
  fallback,
}: EditorViewRouterProps) {
  switch (selectedNode.type) {
    case "can-frame":
      return <CANFrameView {...canFrameProps} />;
    case "checksum":
      return <ChecksumView selectedNode={selectedNode} {...checksumProps} />;
    case "meta":
      return <MetaView {...metaProps} />;
    case "modbus-frame":
      return <ModbusFrameView selectedNode={selectedNode} {...modbusFrameProps} />;
    case "serial-frame":
      return <SerialFrameView selectedNode={selectedNode} {...serialFrameProps} />;
    case "mux":
      return <MuxView {...muxProps} />;
    case "mux-case":
      return <MuxCaseView {...muxCaseProps} />;
    case "node":
      return <NodeView {...nodeProps} />;
    case "signal":
      return <SignalView {...signalProps} />;
    default:
      // For node types not yet migrated, show a generic children browser when possible.
      if (selectedNode.children && selectedNode.children.length > 0) {
        return <GenericChildrenView {...genericChildrenProps} />;
      }
      return <>{fallback}</>;
  }
}

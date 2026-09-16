// ui/src/apps/catalog/views/EditorViewRouter.tsx

import React from "react";
import type { TomlNode } from "../types";
import ArrayView, { ArrayViewProps } from "./ArrayView";
import CANFrameView, { CANFrameViewProps } from "./CANFrameView";
import ChecksumView, { ChecksumViewProps } from "./ChecksumView";
import MetaView, { MetaViewProps } from "./MetaView";
import ModbusFrameView, { ModbusFrameViewProps } from "./ModbusFrameView";
import SerialFrameView, { SerialFrameViewProps } from "./SerialFrameView";
import SerialConfigView, { SerialConfigViewProps } from "./SerialConfigView";
import ModbusConfigView, { ModbusConfigViewProps } from "./ModbusConfigView";
import CanConfigView, { CanConfigViewProps } from "./CanConfigView";
import MuxView, { MuxViewProps } from "./MuxView";
import MuxCaseView, { MuxCaseViewProps } from "./MuxCaseView";
import NodeView, { NodeViewProps } from "./NodeView";
import SignalView, { SignalViewProps } from "./SignalView";
import ValueView, { ValueViewProps } from "./ValueView";
import GenericChildrenView, { GenericChildrenViewProps } from "./GenericChildrenView";

export type EditorViewRouterProps = {
  selectedNode: TomlNode;

  // Migrated views (props provided by CatalogEditor)
  arrayProps: ArrayViewProps;
  canFrameProps: CANFrameViewProps;
  canConfigProps: Omit<CanConfigViewProps, "selectedNode">;
  checksumProps: Omit<ChecksumViewProps, "selectedNode">;
  metaProps: MetaViewProps;
  modbusFrameProps: Omit<ModbusFrameViewProps, "selectedNode">;
  modbusConfigProps: Omit<ModbusConfigViewProps, "selectedNode">;
  serialFrameProps: Omit<SerialFrameViewProps, "selectedNode">;
  serialConfigProps: Omit<SerialConfigViewProps, "selectedNode">;
  muxProps: MuxViewProps;
  muxCaseProps: MuxCaseViewProps;
  nodeProps: NodeViewProps;
  signalProps: SignalViewProps;
  valueProps: ValueViewProps;
  genericChildrenProps: GenericChildrenViewProps;

  // For node types not yet migrated
  fallback: React.ReactNode;
};

// Router handles migrated views. Everything else should render via `fallback`.
export default function EditorViewRouter({
  selectedNode,
  arrayProps,
  canFrameProps,
  canConfigProps,
  checksumProps,
  metaProps,
  modbusFrameProps,
  modbusConfigProps,
  serialFrameProps,
  serialConfigProps,
  muxProps,
  muxCaseProps,
  nodeProps,
  signalProps,
  valueProps,
  genericChildrenProps,
  fallback,
}: EditorViewRouterProps) {
  switch (selectedNode.type) {
    case "array":
      return <ArrayView {...arrayProps} />;
    case "can-frame":
      return <CANFrameView {...canFrameProps} />;
    case "can-config":
      return <CanConfigView selectedNode={selectedNode} {...canConfigProps} />;
    case "checksum":
      return <ChecksumView selectedNode={selectedNode} {...checksumProps} />;
    case "meta":
      return <MetaView {...metaProps} />;
    case "modbus-frame":
      return <ModbusFrameView selectedNode={selectedNode} {...modbusFrameProps} />;
    case "modbus-config":
      return <ModbusConfigView selectedNode={selectedNode} {...modbusConfigProps} />;
    case "serial-frame":
      return <SerialFrameView selectedNode={selectedNode} {...serialFrameProps} />;
    case "serial-config":
      return <SerialConfigView selectedNode={selectedNode} {...serialConfigProps} />;
    case "mux":
      return <MuxView {...muxProps} />;
    case "mux-case":
      return <MuxCaseView {...muxCaseProps} />;
    case "node":
      return <NodeView {...nodeProps} />;
    case "signal":
      return <SignalView {...signalProps} />;
    case "value":
      return <ValueView {...valueProps} />;
    default:
      // For node types not yet migrated, show a generic children browser when possible.
      if (selectedNode.children && selectedNode.children.length > 0) {
        return <GenericChildrenView {...genericChildrenProps} />;
      }
      return <>{fallback}</>;
  }
}

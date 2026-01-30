// ui/src/apps/catalog/views/NodeView.tsx

import React from "react";
import { Plus, Trash2, Pencil } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { caption, labelSmallMuted, monoBody, iconButtonHover, iconButtonHoverDanger, textMedium, bgSecondary, sectionHeaderText, hoverLight } from "../../../styles";
import type { TomlNode } from "../types";
import { tomlParse } from "../toml";
import { formatFrameId } from "../utils";

export type NodeViewProps = {
  selectedNode: TomlNode;
  onSelectNode: (node: TomlNode) => void;
  onSelectPath: (path: string[]) => void;
  catalogContent: string;
  onAddCanFrameForNode?: (nodeName: string) => void;
  onEditNode?: (nodeName: string, notes?: string) => void;
  onDeleteNode?: (nodeName: string) => void;
  onRequestDeleteFrame?: (idKey: string) => void;
  onRequestDeleteSignal?: (idKey: string, index: number, parentPath: string[], signalName?: string) => void;
  displayFrameIdFormat?: "hex" | "decimal";
};

type FrameSignal = {
  name: string;
  start_bit?: number;
  bit_length?: number;
  location?: string;
  path: string[];
  parentPath: string[];
  index: number;
};

type FrameWithSignals = {
  id: string;
  length?: number;
  signals: FrameSignal[];
};

export default function NodeView({
  selectedNode,
  onSelectNode,
  onSelectPath,
  catalogContent,
  onAddCanFrameForNode,
  onEditNode,
  onDeleteNode,
  onRequestDeleteFrame,
  onRequestDeleteSignal,
  displayFrameIdFormat = "hex",
}: NodeViewProps) {
  const nodeName = selectedNode.key;
  const framesForNode = React.useMemo<FrameWithSignals[]>(() => {
    try {
      if (!catalogContent.trim()) return [];

      const parsed = tomlParse(catalogContent) as any;
      const canFrames = parsed?.frame?.can || {};
      const results: FrameWithSignals[] = [];

      const collectMuxSignals = (
        muxObj: any,
        prefix: string | null,
        muxPath: string[],
        acc: FrameSignal[],
        pathPrefix: string[]
      ) => {
        if (!muxObj || typeof muxObj !== "object") return;
        for (const [k, caseVal] of Object.entries<any>(muxObj)) {
          if (["name", "start_bit", "bit_length", "default"].includes(k)) continue;
          if (caseVal?.signals) {
            caseVal.signals.forEach((s: any, idx: number) => {
              acc.push({
                name: s.name || `Signal ${idx + 1}`,
                start_bit: s.start_bit,
                bit_length: s.bit_length,
                location: prefix ? `${prefix} • case ${k}` : `case ${k}`,
                path: [...pathPrefix, "mux", ...muxPath, k, "signals", String(idx)],
                parentPath: [...pathPrefix, "mux", ...muxPath, k],
                index: idx,
              });
            });
          }
          if (caseVal?.mux) {
            collectMuxSignals(
              caseVal.mux,
              prefix ? `${prefix} • case ${k}` : `case ${k}`,
              [...muxPath, k, "mux"],
              acc,
              [...pathPrefix, "mux", ...muxPath, k]
            );
          }
        }
      };

      for (const [id, frameVal] of Object.entries<any>(canFrames)) {
        if (frameVal?.transmitter !== nodeName) continue;

        const signals: FrameSignal[] = [];
        const pathPrefix = ["frame", "can", id];
        const baseSignals = frameVal?.signals || frameVal?.signal || [];
        baseSignals.forEach((s: any, idx: number) => {
          signals.push({
            name: s.name || `Signal ${idx + 1}`,
            start_bit: s.start_bit,
            bit_length: s.bit_length,
            location: "frame",
            path: [...pathPrefix, "signals", String(idx)],
            parentPath: pathPrefix,
            index: idx,
          });
        });

        if (frameVal?.mux) {
          collectMuxSignals(frameVal.mux, null, [], signals, pathPrefix);
        }

        results.push({
          id,
          length: frameVal?.length,
          signals,
        });
      }

      // Sort frames numerically when possible
      return results.sort((a, b) => {
        const toNum = (v: string) => (v?.startsWith?.("0x") ? parseInt(v, 16) : Number(v));
        const aNum = toNum(a.id);
        const bNum = toNum(b.id);
        if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
        return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" });
      });
    } catch (err) {
      console.warn("Failed to parse catalog for node view:", err);
      return [];
    }
  }, [catalogContent, nodeName]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-[color:var(--text-primary)]">Node</h3>

        <div className={flexRowGap2}>
          {onAddCanFrameForNode && (
            <button
              onClick={() => onAddCanFrameForNode(nodeName)}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-xs font-medium"
              title="Add CAN frame for this node"
            >
              <Plus className={iconMd} />
              Add CAN Frame
            </button>
          )}

          {onEditNode && (
            <button
              onClick={() => {
                const notes = selectedNode.metadata?.properties?.notes;
                const notesStr = notes
                  ? (Array.isArray(notes) ? notes.join("\n") : notes)
                  : undefined;
                onEditNode(nodeName, notesStr);
              }}
              className={iconButtonHover}
              title="Edit node"
            >
              <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
            </button>
          )}

          {onDeleteNode && (
            <button
              onClick={() => onDeleteNode(nodeName)}
              className={iconButtonHoverDanger}
              title="Delete node"
            >
              <Trash2 className={`${iconMd} text-[color:var(--text-red)]`} />
            </button>
          )}
        </div>
      </div>

      <div className={`p-4 ${bgSecondary} rounded-lg`}>
        <div className={labelSmallMuted}>Name</div>
        <div className={monoBody}>{nodeName}</div>
      </div>

      {selectedNode.metadata?.properties?.notes && (
        <div className={`p-3 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>Notes</div>
          <div className="text-sm text-[color:var(--text-secondary)] whitespace-pre-wrap">
            {Array.isArray(selectedNode.metadata.properties.notes)
              ? selectedNode.metadata.properties.notes.join("\n")
              : selectedNode.metadata.properties.notes}
          </div>
        </div>
      )}

      {selectedNode.children && selectedNode.children.length > 0 ? (
        <div className="space-y-2">
          <div className={sectionHeaderText}>
            Items ({selectedNode.children.length})
          </div>

          {selectedNode.children.map((child, idx) => (
            <div
              key={idx}
              className={`p-3 ${bgSecondary} rounded-lg ${hoverLight} cursor-pointer transition-colors`}
              onClick={() => onSelectNode(child)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-[color:var(--text-primary)] mb-1 flex items-center gap-2">
                    {child.type === "can-frame" && <span>🔖</span>}
                    {child.type === "modbus-frame" && <span>📟</span>}
                    {child.type === "mux" && <span>🔀</span>}
                    {child.type === "mux-case" && <span>📍</span>}
                    {child.type === "signal" && <span>⚡</span>}
                    {child.key}
                  </div>

                  {child.type === "can-frame" && child.metadata?.length !== undefined && (
                    <div className={caption}>
                      {child.metadata.length} bytes
                      {child.metadata.transmitter ? ` • tx: ${child.metadata.transmitter}` : ""}
                    </div>
                  )}
                </div>

                <div className="text-xs px-2 py-1 bg-[var(--bg-primary)] rounded text-[color:var(--text-muted)]">
                  {child.type}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-[color:var(--text-muted)]">No items</div>
      )}

      <div className="space-y-2">
        <div className={sectionHeaderText}>
          Transmitted CAN Frames ({framesForNode.length})
        </div>

        {framesForNode.length === 0 ? (
          <div className="text-sm text-[color:var(--text-muted)]">No CAN frames use this node as transmitter.</div>
        ) : (
          framesForNode.map((frame) => (
            <div
              key={frame.id}
              className={`p-4 ${bgSecondary} rounded-lg border border-[color:var(--border-default)]`}
            >
              {(() => {
                const formatted = formatFrameId(frame.id, displayFrameIdFormat);
                return (
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium text-[color:var(--text-primary)] flex items-center gap-2">
                  <span>🔖</span>
                  <span className={flexRowGap2}>
                    {formatted.primary}
                    {formatted.secondary && (
                      <span className={caption}>
                        ({formatted.secondary})
                      </span>
                    )}
                  </span>
                </div>
                <div className={flexRowGap2}>
                  {frame.length !== undefined && (
                    <div className={caption}>
                      {frame.length} bytes
                    </div>
                  )}
                  <button
                    onClick={() => onSelectPath(["frame", "can", frame.id])}
                    className={iconButtonHover}
                    title="Edit frame"
                  >
                    <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
                  </button>
                  {onRequestDeleteFrame && (
                    <button
                      onClick={() => onRequestDeleteFrame(frame.id)}
                      className={iconButtonHoverDanger}
                      title="Delete frame"
                    >
                      <Trash2 className={`${iconMd} text-[color:var(--text-red)]`} />
                    </button>
                  )}
                </div>
              </div>
                );
              })()}

              {frame.signals.length === 0 ? (
                <div className={caption}>No signals defined.</div>
              ) : (
                <div className="space-y-2">
                  {frame.signals.map((signal, idx) => (
                    <div key={`${signal.name}-${idx}`} className="flex items-start gap-3">
                      <div className="flex-1">
                        <div className={`${textMedium} flex items-center gap-2`}>
                          <span>⚡</span>
                          {signal.name}
                        </div>
                        <div className={caption}>
                          Bits {signal.start_bit ?? 0} - {(signal.start_bit ?? 0) + (signal.bit_length ?? 0) - 1}
                          {signal.bit_length ? ` (${signal.bit_length} bits)` : ""}
                          {signal.location ? ` • ${signal.location}` : ""}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => onSelectPath(signal.path)}
                          className={iconButtonHover}
                          title="Edit signal"
                        >
                          <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
                        </button>
                        {onRequestDeleteSignal && (
                          <button
                            onClick={() =>
                              onRequestDeleteSignal(
                                frame.id,
                                signal.index,
                                signal.parentPath,
                                signal.name
                              )
                            }
                            className={iconButtonHoverDanger}
                            title="Delete signal"
                          >
                            <Trash2 className={`${iconMd} text-[color:var(--text-red)]`} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

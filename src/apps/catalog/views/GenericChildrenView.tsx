// ui/src/apps/catalog/views/GenericChildrenView.tsx

import { Trash2 } from "lucide-react";
import { iconMd } from "../../../styles/spacing";
import { caption, iconButtonHoverDanger, bgSecondary, sectionHeaderText, hoverLight } from "../../../styles";
import type { TomlNode } from "../types";

export type GenericChildrenViewProps = {
  selectedNode: TomlNode;
  onSelectNode: (node: TomlNode) => void;
  onRequestDelete?: (path: string[], label?: string) => void;
};

export default function GenericChildrenView({ selectedNode, onSelectNode, onRequestDelete }: GenericChildrenViewProps) {
  const hasChildren = !!selectedNode.children && selectedNode.children.length > 0;
  const title = selectedNode.type === "table-array" ? "Signals" : "Properties";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className={sectionHeaderText}>
          {title} ({selectedNode.children?.length ?? 0})
        </div>

        {onRequestDelete && (
          <button
            onClick={() => onRequestDelete(selectedNode.path, selectedNode.key)}
            className={iconButtonHoverDanger}
            title="Delete"
          >
            <Trash2 className={`${iconMd} text-[color:var(--text-danger)]`} />
          </button>
        )}
      </div>

      {hasChildren ? (
        <div className="space-y-2">
          {selectedNode.children!.map((child, idx) => (
            <div
              key={idx}
              className={`p-3 ${bgSecondary} rounded-lg ${hoverLight} cursor-pointer transition-colors`}
              onClick={() => onSelectNode(child)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-[color:var(--text-primary)] mb-1 flex items-center gap-2">
                    {child.type === "signal" && <span>⚡</span>}
                    {child.key}
                  </div>

                  {child.type === "value" && child.value !== undefined && (
                    <div className="font-mono text-xs text-[color:var(--text-muted)] truncate">
                      {String(child.value)}
                    </div>
                  )}

                  {child.type === "signal" && child.metadata?.properties && (
                    <div className={`${caption} mt-1 space-y-0.5`}>
                      {child.metadata.properties.unit && <div>Unit: {child.metadata.properties.unit}</div>}
                      {child.metadata.properties.factor !== undefined && <div>Factor: {child.metadata.properties.factor}</div>}
                    </div>
                  )}

                  {child.type !== "value" && child.type !== "signal" && child.children && (
                    <div className={caption}>
                      {child.children.length} items
                    </div>
                  )}
                </div>

                <div className="text-xs px-2 py-1 bg-[var(--bg-primary)] rounded text-[color:var(--text-muted)]">
                  {child.type === "section" && "table"}
                  {child.type === "table-array" && "array"}
                  {child.type === "signal" && "signal"}
                  {child.type === "array" && `[${child.metadata?.arrayItems?.length || 0}]`}
                  {child.type === "value" && "value"}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-[color:var(--text-muted)]">No items</div>
      )}
    </div>
  );
}

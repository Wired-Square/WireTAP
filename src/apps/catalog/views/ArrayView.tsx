// ui/src/apps/catalog/views/ArrayView.tsx

import type { TomlNode } from "../types";
import { monoBody, bgSecondary, sectionHeaderText } from "../../../styles";

export type ArrayViewProps = {
  selectedNode: TomlNode;
};

export default function ArrayView({ selectedNode }: ArrayViewProps) {
  const items = selectedNode.metadata?.arrayItems || [];

  return (
    <div className="space-y-4">
      <div className={sectionHeaderText}>
        Items ({items.length})
      </div>
      <div className={`p-4 ${bgSecondary} rounded-lg`}>
        {items.length === 0 ? (
          <div className="text-sm text-[color:var(--text-muted)]">No items</div>
        ) : (
          <ul className="space-y-1">
            {items.map((item: any, idx: number) => (
              <li key={idx} className={monoBody}>
                {typeof item === "string" ? `"${item}"` : JSON.stringify(item)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

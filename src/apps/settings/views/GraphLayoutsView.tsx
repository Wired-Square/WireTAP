// ui/src/apps/settings/views/GraphLayoutsView.tsx

import { LayoutGrid, Edit2, Trash2 } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { cardDefault } from "../../../styles/cardStyles";
import { iconButtonHover, iconButtonHoverDanger } from "../../../styles/buttonStyles";
import type { GraphLayout } from "../../../utils/graphLayouts";

type GraphLayoutsViewProps = {
  graphLayouts: GraphLayout[];
  onEditGraphLayout: (layout: GraphLayout) => void;
  onDeleteGraphLayout: (layout: GraphLayout) => void;
};

const formatDate = (timestamp: number) => {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

export default function GraphLayoutsView({
  graphLayouts,
  onEditGraphLayout,
  onDeleteGraphLayout,
}: GraphLayoutsViewProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-[color:var(--text-primary)]">Graph Layouts</h2>

      {graphLayouts.length === 0 ? (
        <div className="text-center py-12 text-[color:var(--text-muted)]">
          <LayoutGrid className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No graph layouts saved yet</p>
          <p className="text-sm mt-2">Save layouts from the Graph app</p>
        </div>
      ) : (
        <div className="space-y-2">
          {graphLayouts.map((layout) => (
            <div
              key={layout.id}
              className={`flex items-center justify-between p-4 ${cardDefault}`}
            >
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <h4 className="font-medium text-[color:var(--text-primary)]">{layout.name}</h4>
                </div>
                <div className="mt-1 text-sm text-[color:var(--text-muted)]">
                  {layout.panels.length} {layout.panels.length === 1 ? 'panel' : 'panels'}
                  {layout.catalogFilename && ` · ${layout.catalogFilename}`}
                  {" · "}
                  Created {formatDate(layout.createdAt)}
                  {layout.updatedAt !== layout.createdAt && ` · Updated ${formatDate(layout.updatedAt)}`}
                </div>
              </div>
              <div className={flexRowGap2}>
                <button
                  onClick={() => onEditGraphLayout(layout)}
                  className={iconButtonHover}
                  title="Edit graph layout"
                >
                  <Edit2 className={`${iconMd} text-[color:var(--text-muted)]`} />
                </button>
                <button
                  onClick={() => onDeleteGraphLayout(layout)}
                  className={iconButtonHoverDanger}
                  title="Delete graph layout"
                >
                  <Trash2 className={`${iconMd} text-[color:var(--text-red)]`} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

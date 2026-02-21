// ui/src/apps/graph/views/GraphGrid.tsx

import { GridLayout, useContainerWidth, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { useGraphStore, type LayoutItem } from "../../../stores/graphStore";
import PanelWrapper from "./panels/PanelWrapper";
import LineChartPanel from "./panels/line-chart/LineChartPanel";
import GaugePanel from "./panels/gauge/GaugePanel";
import ListPanel from "./panels/list/ListPanel";
import { useCallback, useMemo } from "react";
import { textSecondary } from "../../../styles/colourTokens";

interface Props {
  onOpenSignalPicker: (panelId: string) => void;
  onOpenPanelConfig: (panelId: string) => void;
}

const gridConfig = {
  cols: 12,
  rowHeight: 40,
  margin: [8, 8] as const,
};

const dragConfig = {
  handle: ".drag-handle",
};

export default function GraphGrid({ onOpenSignalPicker, onOpenPanelConfig }: Props) {
  const panels = useGraphStore((s) => s.panels);
  const layout = useGraphStore((s) => s.layout);
  const updateLayout = useGraphStore((s) => s.updateLayout);
  const { width, containerRef, mounted } = useContainerWidth({ initialWidth: 800 });

  const handleLayoutChange = useCallback(
    (newLayout: Layout) => {
      const items: LayoutItem[] = newLayout.map((l) => ({
        i: l.i,
        x: l.x,
        y: l.y,
        w: l.w,
        h: l.h,
      }));
      updateLayout(items);
    },
    [updateLayout],
  );

  const rglLayout = useMemo(
    () => layout.map((l) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h })),
    [layout],
  );

  if (panels.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className={`text-sm ${textSecondary}`}>
          Add a panel using the "Add Panel" button above.
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full overflow-auto p-2">
      {mounted && (
        <GridLayout
          layout={rglLayout}
          width={width}
          gridConfig={gridConfig}
          dragConfig={dragConfig}
          onLayoutChange={handleLayoutChange}
        >
          {panels.map((panel) => (
            <div key={panel.id}>
              <PanelWrapper
                panel={panel}
                onOpenSignalPicker={() => onOpenSignalPicker(panel.id)}
                onOpenPanelConfig={() => onOpenPanelConfig(panel.id)}
              >
                {panel.type === "line-chart" ? (
                  <LineChartPanel panel={panel} />
                ) : panel.type === "gauge" ? (
                  <GaugePanel panel={panel} />
                ) : (
                  <ListPanel panel={panel} />
                )}
              </PanelWrapper>
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}

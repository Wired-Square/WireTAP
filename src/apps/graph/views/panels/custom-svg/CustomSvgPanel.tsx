// ui/src/apps/graph/views/panels/custom-svg/CustomSvgPanel.tsx
//
// Complex custom SVG — one panel composing many sub-instruments. Two modes:
//  • scene  — declarative scene-graph (safe, no code execution)
//  • script — author JS runs in the sandboxed Worker and RETURNS markup, which
//             we sanitise (DOMPurify) before injecting. No author code touches
//             the DOM, Tauri, or the network.

import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { useGraphStore, type GraphPanel } from "../../../../../stores/graphStore";
import { customWidgetKeys, makeSignalSampler } from "../../../widgets/useSignalValues";
import WidgetEmpty from "../../../widgets/WidgetEmpty";
import WidgetError from "../../../widgets/WidgetError";
import { renderScene } from "../../../widgets/renderScene";
import { CustomWidgetHost } from "../../../widgets/customWorkerHost";

interface Props {
  panel: GraphPanel;
  svgRef?: React.MutableRefObject<(() => SVGSVGElement | null) | null>;
}

function parseViewBox(vb: string): { w: number; h: number } {
  const p = vb.split(/\s+/).map(Number);
  return { w: p[2] || 200, h: p[3] || 200 };
}

export default function CustomSvgPanel({ panel, svgRef }: Props) {
  const svgElRef = useRef<SVGSVGElement>(null);   // scene mode root
  const containerRef = useRef<HTMLDivElement>(null); // script mode host

  const cfg = panel.widgetConfig?.customSvg;
  const mode = cfg?.mode ?? "scene";
  const viewBox = cfg?.viewBox ?? "0 0 200 200";
  const code = cfg?.code;
  const fps = cfg?.fps ?? 30;
  const keys = customWidgetKeys(panel.signals, cfg?.signalKeys).join(",");

  // Export getter — the live <svg> differs by mode (scene root vs injected svg).
  useEffect(() => {
    if (!svgRef) return;
    svgRef.current = () =>
      mode === "script" ? containerRef.current?.querySelector("svg") ?? null : svgElRef.current;
    return () => { if (svgRef) svgRef.current = null; };
  }, [svgRef, mode]);

  // Scene mode reads reactively from the store.
  const dataVersion = useGraphStore((s) => s.dataVersion);
  const buffers = useGraphStore((s) => s.seriesBuffers);
  void dataVersion;

  const [markup, setMarkup] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "script" || !code) return;
    setError(null);
    const { w, h } = parseViewBox(viewBox);
    const getSignals = makeSignalSampler(keys ? keys.split(",") : []);
    const host = new CustomWidgetHost("svg", code, getSignals, () => ({ width: w, height: h }), fps, {
      // Wrap the author's fragment in a full <svg> before sanitising: DOMPurify
      // parses as HTML, where bare <circle>/<text> outside an <svg> are dropped.
      onSvg: (m) => setMarkup(DOMPurify.sanitize(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" width="100%" height="100%">${m}</svg>`,
        { USE_PROFILES: { svg: true, svgFilters: true } },
      )),
      onError: (msg) => setError(msg),
      onTimeout: () => setError("Draw timed out — code was stopped"),
    });
    return () => host.destroy();
  }, [mode, code, fps, keys, viewBox]);

  if (mode === "scene" && (!cfg?.scene || cfg.scene.length === 0)) {
    return <WidgetEmpty>Configure an SVG scene (or switch to script mode)</WidgetEmpty>;
  }
  if (mode === "script" && !code) {
    return <WidgetEmpty>Add custom SVG code in Configure</WidgetEmpty>;
  }

  const valueOf = (key: string) => buffers.get(key)?.latestValue ?? NaN;

  return (
    <div className="relative h-full w-full">
      {mode === "scene" ? (
        <svg ref={svgElRef} viewBox={viewBox} className="h-full w-full" preserveAspectRatio="xMidYMid meet">
          {renderScene(cfg!.scene!, valueOf)}
        </svg>
      ) : (
        <div ref={containerRef} className="h-full w-full [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: markup }} />
      )}
      {error && <WidgetError>{error}</WidgetError>}
    </div>
  );
}

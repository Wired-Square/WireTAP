// ui/src/apps/dashboard/widgets/renderScene.ts
//
// Renders a declarative custom-SVG scene-graph (a composed instrument cluster:
// a large gauge with smaller partial-arc sub-gauges, lamps, bars, readouts) to
// SVG React elements. Each node binds to one signal value.

import { createElement, type ReactNode } from "react";
import { describeArc, fraction, polarToCartesian, thresholdColour } from "./svgArc";
import type { SceneNode } from "./configTypes";
import { formatValue } from "../utils/dashboardFormat";

type ValueOf = (signalKey: string) => number;

const ease = { transition: "all 0.15s ease-out" } as const;

function renderNode(n: SceneNode, key: number, valueOf: ValueOf): ReactNode {
  switch (n.kind) {
    case "arc": {
      const v = valueOf(n.bind.signalKey);
      const pct = Number.isFinite(v) ? fraction(v, n.bind.min, n.bind.max) : 0;
      const valueAngle = n.startAngle + (n.endAngle - n.startAngle) * pct;
      const colour = thresholdColour(pct, n.colour ?? "#3b82f6", n.thresholds);
      return createElement(
        "g",
        { key },
        createElement("path", { d: describeArc(n.cx, n.cy, n.r, n.startAngle, n.endAngle), fill: "none", stroke: "var(--border-default)", strokeWidth: n.thickness, strokeLinecap: "round" }),
        pct > 0.001 &&
          createElement("path", { d: describeArc(n.cx, n.cy, n.r, n.startAngle, valueAngle), fill: "none", stroke: colour, strokeWidth: n.thickness, strokeLinecap: "round", style: ease }),
      );
    }
    case "needle": {
      const v = valueOf(n.bind.signalKey);
      const pct = Number.isFinite(v) ? fraction(v, n.bind.min, n.bind.max) : 0;
      const angle = n.startAngle + (n.endAngle - n.startAngle) * pct;
      const tip = polarToCartesian(n.cx, n.cy, n.length, angle);
      return createElement("line", { key, x1: n.cx, y1: n.cy, x2: tip.x, y2: tip.y, stroke: n.colour ?? "var(--text-primary)", strokeWidth: 2, strokeLinecap: "round", style: ease });
    }
    case "lamp": {
      const v = valueOf(n.bind.signalKey);
      let st = n.states[0];
      let best = Infinity;
      for (const s of n.states) {
        const d = Math.abs(s.value - v);
        if (Number.isFinite(v) && d < best) { best = d; st = s; }
      }
      const opacity = st ? 0.25 + 0.75 * (st.brightness ?? 1) : 0.25;
      return createElement("circle", { key, cx: n.cx, cy: n.cy, r: n.r, fill: st?.colour ?? "var(--border-default)", opacity, style: ease });
    }
    case "bar": {
      const v = valueOf(n.bind.signalKey);
      const pct = Number.isFinite(v) ? fraction(v, n.bind.min, n.bind.max) : 0;
      const colour = n.colour ?? "#3b82f6";
      const track = createElement("rect", { x: n.x, y: n.y, width: n.w, height: n.h, rx: 2, fill: "var(--border-default)" });
      const fill = n.orientation === "vertical"
        ? createElement("rect", { x: n.x, y: n.y + n.h * (1 - pct), width: n.w, height: n.h * pct, rx: 2, fill: colour, style: ease })
        : createElement("rect", { x: n.x, y: n.y, width: n.w * pct, height: n.h, rx: 2, fill: colour, style: ease });
      return createElement("g", { key }, track, fill);
    }
    case "text": {
      const v = n.bind ? valueOf(n.bind.signalKey) : NaN;
      const shown = Number.isFinite(v) ? formatValue(v) : "";
      const label = n.template
        ? n.template.replace(/\{v(?:alue)?\}/g, shown)
        : `${shown}${n.unit ? ` ${n.unit}` : ""}`;
      return createElement("text", { key, x: n.x, y: n.y, textAnchor: "middle", dominantBaseline: "middle", fill: n.colour ?? "var(--text-primary)", fontSize: n.fontSize ?? 12, fontFamily: "ui-monospace, monospace" }, label);
    }
  }
}

export function renderScene(nodes: SceneNode[], valueOf: ValueOf): ReactNode[] {
  return nodes.map((n, i) => renderNode(n, i, valueOf));
}

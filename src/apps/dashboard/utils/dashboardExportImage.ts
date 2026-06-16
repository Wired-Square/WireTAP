// ui/src/apps/dashboard/utils/dashboardExportImage.ts
//
// Image export utilities for graph panels (PNG, SVG, interactive SVG).

import { saveBinaryFile, saveCatalog } from "../../../api/catalog";
import {
  readTimeSeries,
  getSignalLabel,
  type SignalRef,
  type SignalTimeSeries,
} from "../../../stores/dashboardStore";

// ─────────────────────────────────────────
// PNG export (canvas-based panels)
// ─────────────────────────────────────────

/** Export an HTML canvas element as a PNG file. */
export async function exportCanvasAsPng(
  canvas: HTMLCanvasElement,
  path: string,
): Promise<void> {
  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.slice("data:image/png;base64,".length);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  await saveBinaryFile(path, Array.from(bytes));
}

// ─────────────────────────────────────────
// SVG element export (gauge, heatmap)
// ─────────────────────────────────────────

/** Resolve CSS variable references in a string to their computed values. */
function resolveCssVars(svgString: string): string {
  const style = getComputedStyle(document.documentElement);
  return svgString.replace(/var\(--([a-z0-9-]+)\)/gi, (_, name) => {
    const value = style.getPropertyValue(`--${name}`).trim();
    return value || `var(--${name})`;
  });
}

/** Export an SVG DOM element as an SVG file with CSS variables resolved. */
export async function exportSvgElementAsSvg(
  svgEl: SVGSVGElement,
  path: string,
): Promise<void> {
  const raw = new XMLSerializer().serializeToString(svgEl);
  const resolved = resolveCssVars(raw);
  // Ensure xmlns is present
  const withNs = resolved.includes("xmlns=")
    ? resolved
    : resolved.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  const full = `<?xml version="1.0" encoding="UTF-8"?>\n${withNs}`;
  await saveCatalog(path, full);
}

/** Export an SVG DOM element as a PNG by drawing it onto an offscreen canvas. */
export async function exportSvgElementAsPng(
  svgEl: SVGSVGElement,
  path: string,
  scale = 2,
): Promise<void> {
  const raw = new XMLSerializer().serializeToString(svgEl);
  const resolved = resolveCssVars(raw);
  const withNs = resolved.includes("xmlns=")
    ? resolved
    : resolved.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');

  const viewBox = svgEl.getAttribute("viewBox")?.split(/\s+/).map(Number);
  const width = viewBox ? viewBox[2] : svgEl.clientWidth || 200;
  const height = viewBox ? viewBox[3] : svgEl.clientHeight || 200;

  const blob = new Blob([withNs], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    const img = new Image();
    img.width = width * scale;
    img.height = height * scale;

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to load SVG for PNG export"));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, width * scale, height * scale);
    await exportCanvasAsPng(canvas, path);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─────────────────────────────────────────
// SVG chart export (line-chart, flow, histogram)
// ─────────────────────────────────────────

interface ChartExportOptions {
  signals: SignalRef[];
  buffers: Map<string, SignalTimeSeries>;
  width: number;
  height: number;
  path: string;
  interactive?: boolean;
}

/**
 * Generate an SVG representation of chart signal data.
 * This produces a clean vector export with polylines, axes, and grid.
 */
export async function exportChartAsSvg(opts: ChartExportOptions): Promise<void> {
  const { signals, buffers, width, height, path, interactive } = opts;
  const padding = { top: 20, right: 20, bottom: 40, left: 60 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  // Read all series data
  const seriesData = signals.map((sig) => {
    const key = `${sig.frameId}:${sig.signalName}`;
    const series = buffers.get(key);
    if (series && series.count > 0) return readTimeSeries(series);
    return { timestamps: [] as number[], values: [] as number[] };
  });

  // Compute global time and value ranges
  let tMin = Infinity, tMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const s of seriesData) {
    for (const t of s.timestamps) { if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
    for (const v of s.values) { if (v < vMin) vMin = v; if (v > vMax) vMax = v; }
  }
  if (!isFinite(tMin)) tMin = 0;
  if (!isFinite(tMax)) tMax = 1;
  if (!isFinite(vMin)) vMin = 0;
  if (!isFinite(vMax)) vMax = 1;
  if (tMax === tMin) tMax = tMin + 1;
  if (vMax === vMin) { vMin -= 0.5; vMax += 0.5; }

  // Add 5% padding to value range
  const vPad = (vMax - vMin) * 0.05;
  vMin -= vPad;
  vMax += vPad;

  const scaleX = (t: number) => padding.left + ((t - tMin) / (tMax - tMin)) * plotW;
  const scaleY = (v: number) => padding.top + plotH - ((v - vMin) / (vMax - vMin)) * plotH;

  const textCol = getComputedStyle(document.documentElement).getPropertyValue("--text-primary").trim() || "#e2e8f0";
  const gridCol = getComputedStyle(document.documentElement).getPropertyValue("--border-default").trim() || "rgba(255,255,255,0.1)";
  const bgCol = getComputedStyle(document.documentElement).getPropertyValue("--bg-primary").trim() || "#0f172a";

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  lines.push(`<rect width="${width}" height="${height}" fill="${bgCol}"/>`);

  // Grid lines (5 horizontal, 5 vertical)
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (plotH / 5) * i;
    lines.push(`<line x1="${padding.left}" y1="${y}" x2="${padding.left + plotW}" y2="${y}" stroke="${gridCol}" stroke-width="0.5"/>`);
    const val = vMax - ((vMax - vMin) / 5) * i;
    lines.push(`<text x="${padding.left - 5}" y="${y + 3}" text-anchor="end" fill="${textCol}" font-size="10" font-family="ui-monospace, monospace">${val.toPrecision(4)}</text>`);
  }
  for (let i = 0; i <= 5; i++) {
    const x = padding.left + (plotW / 5) * i;
    lines.push(`<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${padding.top + plotH}" stroke="${gridCol}" stroke-width="0.5"/>`);
    const t = tMin + ((tMax - tMin) / 5) * i;
    lines.push(`<text x="${x}" y="${height - 10}" text-anchor="middle" fill="${textCol}" font-size="10" font-family="ui-monospace, monospace">${t.toFixed(2)}s</text>`);
  }

  // Plot border
  lines.push(`<rect x="${padding.left}" y="${padding.top}" width="${plotW}" height="${plotH}" fill="none" stroke="${gridCol}" stroke-width="1"/>`);

  // Polylines for each signal
  const pointGroups: { label: string; colour: string; points: Array<{ cx: number; cy: number; value: number; time: number }> }[] = [];

  for (let si = 0; si < signals.length; si++) {
    const sig = signals[si];
    const data = seriesData[si];
    if (data.timestamps.length === 0) continue;

    const label = getSignalLabel(sig);
    const pts = data.timestamps.map((t, j) => ({
      cx: scaleX(t),
      cy: scaleY(data.values[j]),
      value: data.values[j],
      time: t,
    }));

    // Downsample for large datasets (max ~2000 points per series)
    const maxPoints = 2000;
    const step = pts.length > maxPoints ? Math.ceil(pts.length / maxPoints) : 1;
    const sampled = step > 1 ? pts.filter((_, i) => i % step === 0) : pts;

    const pointsStr = sampled.map((p) => `${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(" ");
    lines.push(`<polyline points="${pointsStr}" fill="none" stroke="${sig.colour}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`);

    if (interactive) {
      pointGroups.push({ label, colour: sig.colour, points: sampled });
    }
  }

  // Legend
  const legendY = height - 5;
  for (let i = 0; i < signals.length; i++) {
    const x = padding.left + i * 120;
    lines.push(`<circle cx="${x}" cy="${legendY - 3}" r="3" fill="${signals[i].colour}"/>`);
    lines.push(`<text x="${x + 7}" y="${legendY}" fill="${textCol}" font-size="10" font-family="ui-monospace, monospace">${getSignalLabel(signals[i])}</text>`);
  }

  // Interactive features
  if (interactive) {
    // Invisible hover circles and tooltip
    for (const group of pointGroups) {
      for (const pt of group.points) {
        lines.push(`<circle cx="${pt.cx.toFixed(1)}" cy="${pt.cy.toFixed(1)}" r="4" fill="transparent" stroke="none">`);
        lines.push(`<title>${group.label}: ${pt.value.toPrecision(6)} @ ${pt.time.toFixed(4)}s</title>`);
        lines.push(`</circle>`);
      }
    }

    // Embed interactive script for pan/zoom
    lines.push(`<script type="text/javascript"><![CDATA[`);
    lines.push(`(function(){`);
    lines.push(`  var svg=document.querySelector('svg');`);
    lines.push(`  var vb={x:0,y:0,w:${width},h:${height}};`);
    lines.push(`  var dragging=false,lastX,lastY;`);
    lines.push(`  function setVB(){svg.setAttribute('viewBox',vb.x+' '+vb.y+' '+vb.w+' '+vb.h)}`);
    lines.push(`  svg.addEventListener('wheel',function(e){`);
    lines.push(`    e.preventDefault();`);
    lines.push(`    var f=e.deltaY>0?1.1:0.9;`);
    lines.push(`    var pt=svg.createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;`);
    lines.push(`    var p=pt.matrixTransform(svg.getScreenCTM().inverse());`);
    lines.push(`    vb.x=p.x-(p.x-vb.x)*f; vb.y=p.y-(p.y-vb.y)*f;`);
    lines.push(`    vb.w*=f; vb.h*=f; setVB();`);
    lines.push(`  });`);
    lines.push(`  svg.addEventListener('mousedown',function(e){dragging=true;lastX=e.clientX;lastY=e.clientY});`);
    lines.push(`  svg.addEventListener('mousemove',function(e){`);
    lines.push(`    if(!dragging)return;`);
    lines.push(`    var s=vb.w/${width};`);
    lines.push(`    vb.x-=(e.clientX-lastX)*s; vb.y-=(e.clientY-lastY)*s;`);
    lines.push(`    lastX=e.clientX; lastY=e.clientY; setVB();`);
    lines.push(`  });`);
    lines.push(`  svg.addEventListener('mouseup',function(){dragging=false});`);
    lines.push(`  svg.addEventListener('mouseleave',function(){dragging=false});`);
    lines.push(`  // Tooltip highlight on hover`);
    lines.push(`  svg.querySelectorAll('circle[r="4"]').forEach(function(c){`);
    lines.push(`    c.addEventListener('mouseenter',function(){c.setAttribute('r','6');c.setAttribute('fill',c.closest?c.previousElementSibling?c.previousElementSibling.getAttribute('stroke'):'#fff':'#fff');c.style.opacity='0.8'});`);
    lines.push(`    c.addEventListener('mouseleave',function(){c.setAttribute('r','4');c.setAttribute('fill','transparent');c.style.opacity='1'});`);
    lines.push(`  });`);
    lines.push(`})();`);
    lines.push(`]]></script>`);
  }

  lines.push(`</svg>`);
  await saveCatalog(path, lines.join("\n"));
}

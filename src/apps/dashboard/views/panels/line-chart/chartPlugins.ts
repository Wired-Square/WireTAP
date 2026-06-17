// ui/src/apps/dashboard/views/panels/line-chart/chartPlugins.ts
//
// Centralised uPlot plugins for the line chart panel.
// All plugins share the same CSS-variable-based styling and formatting helpers.

import type uPlot from "uplot";
import type { SignalRef } from "../../../../../stores/dashboardStore";
import { getSignalLabel } from "../../../../../stores/dashboardStore";
import { formatValue, formatTimestamp, formatTimeDelta } from "../../../utils/dashboardFormat";

// ─────────────────────────────────────────
// Shared tooltip DOM styling (CSS variables)
// ─────────────────────────────────────────

const TOOLTIP_CSS = `
  display: none;
  position: fixed;
  pointer-events: none;
  z-index: 9999;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.5;
  white-space: nowrap;
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
`;

/** Position a fixed tooltip near a cursor point, flipping at viewport edges. */
function positionTooltip(
  tooltip: HTMLElement,
  anchorLeft: number,
  anchorTop: number,
) {
  const rect = tooltip.getBoundingClientRect();

  let tipX = anchorLeft + 12;
  let tipY = anchorTop - rect.height / 2;

  // Flip to left side if too close to right edge
  if (tipX + rect.width > window.innerWidth - 8) {
    tipX = anchorLeft - rect.width - 12;
  }
  // Clamp vertical position to viewport
  tipY = Math.max(4, Math.min(tipY, window.innerHeight - rect.height - 4));

  tooltip.style.left = `${tipX}px`;
  tooltip.style.top = `${tipY}px`;
}

/** Build HTML for a signal value row (colour dot + label + confidence + value + unit). */
function signalRowHtml(
  sig: SignalRef,
  value: number | null | undefined,
  confidenceColours?: ConfidenceColours,
): string {
  let html = `<div style="display: flex; align-items: center; gap: 6px;">`;
  html += `<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${sig.colour}; flex-shrink: 0;"></span>`;
  html += `<span style="color: var(--text-secondary);">${getSignalLabel(sig)}</span>`;
  if (sig.confidence && confidenceColours) {
    const confCol = confidenceColours[sig.confidence] || confidenceColours.none;
    html += `<span style="display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: ${confCol}; flex-shrink: 0;" title="Confidence: ${sig.confidence}"></span>`;
  }
  html += `<span style="margin-left: auto; font-family: ui-monospace, monospace; font-weight: 500;">${formatValue(value)}</span>`;
  if (sig.unit) html += `<span style="color: var(--text-muted); font-size: 10px;">${sig.unit}</span>`;
  html += `</div>`;
  return html;
}

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface ConfidenceColours {
  none: string;
  low: string;
  medium: string;
  high: string;
}

export interface InteractionCallbacks {
  /** Called when the user manually zooms or pans (for auto-disabling follow mode). */
  onUserInteraction?: () => void;
}

// ─────────────────────────────────────────
// Tooltip Plugin (moved from LineChartPanel)
// ─────────────────────────────────────────

/** Shows signal values at cursor position. Portalled to document.body. */
export function tooltipPlugin(
  signals: SignalRef[],
  confidenceColours?: ConfidenceColours,
): uPlot.Plugin {
  let tooltip: HTMLDivElement;

  return {
    hooks: {
      init(_u: uPlot) {
        tooltip = document.createElement("div");
        tooltip.style.cssText = TOOLTIP_CSS;
        document.body.appendChild(tooltip);
      },
      setCursor(u: uPlot) {
        const idx = u.cursor.idx;
        if (idx == null || idx < 0) {
          tooltip.style.display = "none";
          return;
        }

        const ts = u.data[0]?.[idx];
        if (ts == null) {
          tooltip.style.display = "none";
          return;
        }

        // Build tooltip content
        let html = `<div style="color: var(--text-muted); margin-bottom: 2px;">${formatTimestamp(ts)}</div>`;
        for (let i = 0; i < signals.length; i++) {
          const val = u.data[i + 1]?.[idx];
          html += signalRowHtml(signals[i], val as number | null, confidenceColours);
        }

        tooltip.innerHTML = html;
        tooltip.style.display = "block";

        // Position near cursor
        const overRect = u.over.getBoundingClientRect();
        const cursorLeft = u.cursor.left ?? 0;
        const cursorTop = u.cursor.top ?? 0;
        positionTooltip(tooltip, overRect.left + cursorLeft, overRect.top + cursorTop);
      },
      destroy(_u: uPlot) {
        tooltip?.remove();
      },
    },
  };
}

// ─────────────────────────────────────────
// Wheel Zoom Plugin
// ─────────────────────────────────────────

/** Zooms the X-axis with the mouse wheel, centred on cursor position. */
export function wheelZoomPlugin(callbacks?: InteractionCallbacks): uPlot.Plugin {
  return {
    hooks: {
      init(u: uPlot) {
        const over = u.over;
        over.addEventListener("wheel", (e: WheelEvent) => {
          e.preventDefault();

          const xMin = u.scales.x.min!;
          const xMax = u.scales.x.max!;
          const xRange = xMax - xMin;

          // Zoom factor: scroll up = zoom in, scroll down = zoom out
          const factor = e.deltaY > 0 ? 1.25 : 0.8;

          // Cursor position as a fraction across the plot area
          const rect = over.getBoundingClientRect();
          const cursorFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

          // Zoom centred on cursor position
          const cursorVal = xMin + cursorFrac * xRange;
          const newRange = xRange * factor;
          const newMin = cursorVal - cursorFrac * newRange;
          const newMax = cursorVal + (1 - cursorFrac) * newRange;

          u.setScale("x", { min: newMin, max: newMax });
          callbacks?.onUserInteraction?.();
        }, { passive: false });
      },
    },
  };
}

// ─────────────────────────────────────────
// Pan Plugin
// ─────────────────────────────────────────

/** Pans the X-axis with middle-click drag or Shift+left-click drag. */
export function panPlugin(callbacks?: InteractionCallbacks): uPlot.Plugin {
  return {
    hooks: {
      init(u: uPlot) {
        const over = u.over;
        let isPanning = false;
        let startX = 0;
        let startMin = 0;
        let startMax = 0;

        over.addEventListener("mousedown", (e: MouseEvent) => {
          // Middle-click or Shift+left-click
          if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
            e.preventDefault();
            isPanning = true;
            startX = e.clientX;
            startMin = u.scales.x.min!;
            startMax = u.scales.x.max!;
            over.style.cursor = "grabbing";
          }
        });

        const onMouseMove = (e: MouseEvent) => {
          if (!isPanning) return;
          e.preventDefault();

          const rect = over.getBoundingClientRect();
          const pxRange = rect.width;
          const xRange = startMax - startMin;

          // Convert pixel delta to data-space delta
          const pxDelta = e.clientX - startX;
          const dataDelta = -(pxDelta / pxRange) * xRange;

          u.setScale("x", { min: startMin + dataDelta, max: startMax + dataDelta });
          callbacks?.onUserInteraction?.();
        };

        const onMouseUp = (e: MouseEvent) => {
          if (!isPanning) return;
          if (e.button === 1 || e.button === 0) {
            isPanning = false;
            over.style.cursor = "";
          }
        };

        // Attach move/up to document so they work even if cursor leaves the chart
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      },
    },
  };
}

// ─────────────────────────────────────────
// Measurement Plugin (Dual Cursors)
// ─────────────────────────────────────────

const CURSOR_LINE_CSS = `
  position: absolute;
  top: 0;
  width: 0;
  height: 100%;
  border-left: 1px dashed var(--text-muted);
  pointer-events: none;
  z-index: 50;
`;

const MEASUREMENT_OVERLAY_CSS = `
  display: none;
  position: fixed;
  pointer-events: none;
  z-index: 9999;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.5;
  white-space: nowrap;
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
`;

/** Find the data index closest to a given timestamp. */
function findClosestIdx(timestamps: ArrayLike<number>, target: number): number {
  let lo = 0;
  let hi = timestamps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timestamps[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  // Check lo-1 in case it's closer
  if (lo > 0 && Math.abs(timestamps[lo - 1] - target) < Math.abs(timestamps[lo] - target)) {
    return lo - 1;
  }
  return lo;
}

/** Click to place two measurement cursors. Shows values at both cursors and deltas. */
export function measurementPlugin(
  signals: SignalRef[],
  confidenceColours?: ConfidenceColours,
): uPlot.Plugin {
  // State: idle → cursor1 placed → cursor2 placed → idle (cycle)
  let cursor1Ts: number | null = null;
  let cursor2Ts: number | null = null;
  let line1: HTMLDivElement;
  let line2: HTMLDivElement;
  let overlay: HTMLDivElement;
  let mouseDownX = 0;
  let mouseDownY = 0;

  function updateLines(u: uPlot) {
    const over = u.over;
    const plotLeft = 0;
    const plotWidth = over.clientWidth;

    const xMin = u.scales.x.min!;
    const xMax = u.scales.x.max!;
    const xRange = xMax - xMin;

    // Position line 1
    if (cursor1Ts != null && xRange > 0) {
      const frac = (cursor1Ts - xMin) / xRange;
      if (frac >= 0 && frac <= 1) {
        line1.style.left = `${plotLeft + frac * plotWidth}px`;
        line1.style.display = "block";
      } else {
        line1.style.display = "none";
      }
    } else {
      line1.style.display = "none";
    }

    // Position line 2
    if (cursor2Ts != null && xRange > 0) {
      const frac = (cursor2Ts - xMin) / xRange;
      if (frac >= 0 && frac <= 1) {
        line2.style.left = `${plotLeft + frac * plotWidth}px`;
        line2.style.display = "block";
      } else {
        line2.style.display = "none";
      }
    } else {
      line2.style.display = "none";
    }
  }

  function updateOverlay(u: uPlot) {
    if (cursor1Ts == null || cursor2Ts == null) {
      overlay.style.display = "none";
      return;
    }

    const timestamps = u.data[0];
    if (!timestamps || timestamps.length === 0) {
      overlay.style.display = "none";
      return;
    }

    const idx1 = findClosestIdx(timestamps, cursor1Ts);
    const idx2 = findClosestIdx(timestamps, cursor2Ts);
    const t1 = timestamps[idx1];
    const t2 = timestamps[idx2];

    let html = `<div style="display: flex; gap: 12px; margin-bottom: 4px; color: var(--text-muted); font-size: 10px;">`;
    html += `<span>C1: ${formatTimestamp(t1)}</span>`;
    html += `<span>C2: ${formatTimestamp(t2)}</span>`;
    html += `<span style="font-weight: 600; color: var(--text-primary);">Δt: ${formatTimeDelta(t2 - t1)}</span>`;
    html += `</div>`;

    // Header row
    html += `<div style="display: grid; grid-template-columns: 1fr auto auto auto; gap: 4px 8px; align-items: center;">`;
    html += `<span style="font-size: 10px; color: var(--text-muted);"></span>`;
    html += `<span style="font-size: 10px; color: var(--text-muted); text-align: right;">C1</span>`;
    html += `<span style="font-size: 10px; color: var(--text-muted); text-align: right;">C2</span>`;
    html += `<span style="font-size: 10px; color: var(--text-muted); text-align: right;">Δ</span>`;

    for (let i = 0; i < signals.length; i++) {
      const sig = signals[i];
      const v1 = u.data[i + 1]?.[idx1] as number | null | undefined;
      const v2 = u.data[i + 1]?.[idx2] as number | null | undefined;
      const delta = (v1 != null && v2 != null) ? v2 - v1 : null;

      // Signal label with colour dot
      html += `<div style="display: flex; align-items: center; gap: 4px;">`;
      html += `<span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: ${sig.colour}; flex-shrink: 0;"></span>`;
      html += `<span style="color: var(--text-secondary);">${getSignalLabel(sig)}</span>`;
      if (sig.confidence && confidenceColours) {
        const confCol = confidenceColours[sig.confidence] || confidenceColours.none;
        html += `<span style="display: inline-block; width: 4px; height: 4px; border-radius: 50%; background: ${confCol}; flex-shrink: 0;"></span>`;
      }
      html += `</div>`;

      const monoStyle = `font-family: ui-monospace, monospace; font-weight: 500; text-align: right;`;
      html += `<span style="${monoStyle}">${formatValue(v1)}</span>`;
      html += `<span style="${monoStyle}">${formatValue(v2)}</span>`;
      html += `<span style="${monoStyle} color: var(--text-primary); font-weight: 600;">${formatValue(delta)}</span>`;
    }
    html += `</div>`;

    overlay.innerHTML = html;
    overlay.style.display = "block";

    // Position overlay between the two cursor lines
    const overRect = u.over.getBoundingClientRect();
    const xMin = u.scales.x.min!;
    const xMax = u.scales.x.max!;
    const xRange = xMax - xMin;
    const midFrac = ((cursor1Ts + cursor2Ts) / 2 - xMin) / xRange;
    const anchorX = overRect.left + midFrac * overRect.width;
    const anchorY = overRect.top + overRect.height * 0.3;
    positionTooltip(overlay, anchorX, anchorY);
  }

  return {
    hooks: {
      init(u: uPlot) {
        const over = u.over;

        // Create cursor lines inside the plot overlay
        line1 = document.createElement("div");
        line1.style.cssText = CURSOR_LINE_CSS;
        line1.style.display = "none";
        line1.style.borderColor = "var(--accent-info, #3b82f6)";
        over.appendChild(line1);

        line2 = document.createElement("div");
        line2.style.cssText = CURSOR_LINE_CSS;
        line2.style.display = "none";
        line2.style.borderColor = "var(--accent-warning, #f59e0b)";
        over.appendChild(line2);

        // Create measurement overlay portalled to body
        overlay = document.createElement("div");
        overlay.style.cssText = MEASUREMENT_OVERLAY_CSS;
        document.body.appendChild(overlay);

        // Track mousedown position to distinguish clicks from drags
        over.addEventListener("mousedown", (e: MouseEvent) => {
          if (e.button === 0 && !e.shiftKey) {
            mouseDownX = e.clientX;
            mouseDownY = e.clientY;
          }
        });

        over.addEventListener("mouseup", (e: MouseEvent) => {
          if (e.button !== 0 || e.shiftKey) return;

          // Only treat as click if mouse didn't move significantly (not a drag-zoom)
          const dx = Math.abs(e.clientX - mouseDownX);
          const dy = Math.abs(e.clientY - mouseDownY);
          if (dx > 4 || dy > 4) return;

          // Convert click position to timestamp
          const rect = over.getBoundingClientRect();
          const frac = (e.clientX - rect.left) / rect.width;
          const xMin = u.scales.x.min!;
          const xMax = u.scales.x.max!;
          const ts = xMin + frac * (xMax - xMin);

          if (cursor1Ts == null) {
            // Place first cursor
            cursor1Ts = ts;
            cursor2Ts = null;
          } else if (cursor2Ts == null) {
            // Place second cursor
            cursor2Ts = ts;
          } else {
            // Both placed — clear both
            cursor1Ts = null;
            cursor2Ts = null;
          }

          updateLines(u);
          updateOverlay(u);
        });

        // Double-click clears cursors
        over.addEventListener("dblclick", () => {
          cursor1Ts = null;
          cursor2Ts = null;
          updateLines(u);
          updateOverlay(u);
        });
      },
      setScale(u: uPlot, key: string) {
        if (key === "x") {
          updateLines(u);
          updateOverlay(u);
        }
      },
      destroy(_u: uPlot) {
        line1?.remove();
        line2?.remove();
        overlay?.remove();
      },
    },
  };
}

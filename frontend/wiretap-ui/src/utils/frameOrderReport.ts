// ui/src/utils/frameOrderReport.ts
// Report generation for Frame Order analysis results, one section per protocol and bus

import type { BusOrder } from '../generated/BusOrder';
import type { FrameKey } from '../generated/FrameKey';
import type { MultiBusFrame } from '../generated/MultiBusFrame';
import type { MuxTiming } from '../generated/MuxTiming';
import type { ProtocolOrder } from '../generated/ProtocolOrder';
import type { ExportFormat } from './reportExport';
import { formatMs, formatOptionalMs, DARK_THEME_STYLES, PRINT_THEME_STYLES } from './reportExport';
import { formatFrameKey } from './frameIds';
import { protocolLabel } from './profileTraits';

type Format = (key: FrameKey) => string;

type Bus = { title: string; format: Format; bus: BusOrder };

type Report = {
  totalFrames: number;
  uniqueKeys: number;
  timeSpanMs: number;
  buses: Bus[];
  multiBus: { format: Format; frame: MultiBusFrame }[];
};

const MAX_CANDIDATES = 10;

function report(orders: ProtocolOrder[]): Report {
  const formatters = orders.map(({ protocol, order }) => ({ order, protocol, format: (key: FrameKey) => formatFrameKey(protocol, key) }));
  return {
    totalFrames: orders.reduce((n, o) => n + o.order.totalFrames, 0),
    uniqueKeys: orders.reduce((n, o) => n + o.order.uniqueKeys, 0),
    timeSpanMs: Math.max(0, ...orders.map((o) => o.order.timeSpanMs)),
    buses: formatters.flatMap(({ order, protocol, format }) =>
      order.buses.map((bus) => ({ title: `${protocolLabel(protocol)} · Bus ${bus.bus}`, format, bus }))
    ),
    multiBus: formatters.flatMap(({ order, format }) => order.multiBus.map((frame) => ({ format, frame }))),
  };
}

const muxCases = (mux: MuxTiming, limit: number) => {
  const values = Object.keys(mux.occurrences).map(Number);
  const shown = values.slice(0, limit).map((v) => (mux.selector === 'twoByte' ? `${Math.floor(v / 256)}.${v % 256}` : String(v)));
  return { shown, more: values.length > limit };
};

const selectorText = (mux: MuxTiming) => (mux.selector === 'twoByte' ? 'byte[0:1]' : 'byte[0]');

const burstSize = (framesPerBurst: number) => (framesPerBurst === 1 ? '—' : `~${framesPerBurst.toFixed(1)}`);

const busCounts = (frame: MultiBusFrame) => Object.entries(frame.framesPerBus);

/**
 * Generate report content for Frame Order analysis
 */
export function generateFrameOrderReport(results: ProtocolOrder[], format: ExportFormat): string {
  switch (format) {
    case "text":
      return generateTextReport(report(results));
    case "markdown":
      return generateMarkdownReport(report(results));
    case "html-screen":
      return generateHtmlReport(report(results));
    case "html-print":
      return generatePrintReport(report(results));
    case "json":
      return JSON.stringify(results, null, 2);
  }
}

// ============================================================================
// Text Report
// ============================================================================

function generateTextReport(r: Report): string {
  const lines: string[] = [];
  const divider = "═".repeat(70);
  const thinDivider = "─".repeat(70);

  lines.push(divider);
  lines.push("  FRAME ORDER ANALYSIS REPORT");
  lines.push(divider);
  lines.push("");

  lines.push("SUMMARY");
  lines.push(thinDivider);
  lines.push(`  Total Frames Analysed: ${r.totalFrames.toLocaleString()}`);
  lines.push(`  Unique Frame IDs:      ${r.uniqueKeys}`);
  lines.push(`  Time Span:             ${formatMs(r.timeSpanMs)}`);
  lines.push("");

  for (const { title, format, bus } of r.buses) {
    lines.push(divider);
    lines.push(`  ${title.toUpperCase()} (${bus.frameCount.toLocaleString()} frames)`);
    lines.push(divider);
    lines.push("");

    if (bus.patterns.length > 0) {
      lines.push("DETECTED PATTERNS");
      lines.push(thinDivider);
      bus.patterns.forEach((pattern, i) => {
        lines.push(`  Pattern #${i + 1}`);
        lines.push(`    Start ID:    ${format(pattern.start)}`);
        lines.push(`    Sequence:    ${pattern.sequence.map(format).join(" → ")}`);
        lines.push(`    Occurrences: ${pattern.occurrences}`);
        lines.push(`    Confidence:  ${Math.round(pattern.confidence * 100)}%`);
        lines.push(`    Cycle:       ${formatOptionalMs(pattern.cycleMs)}`);
        lines.push("");
      });
    }

    if (bus.mux.length > 0) {
      lines.push("MULTIPLEXED FRAMES");
      lines.push(thinDivider);
      for (const mux of bus.mux) {
        lines.push(`  ${format(mux)}`);
        lines.push(`    Selector:    ${selectorText(mux)}`);
        lines.push(`    Cases:       ${muxCases(mux, Infinity).shown.join(", ")}`);
        lines.push(`    Mux Period:  ${formatOptionalMs(mux.muxPeriodMs)}`);
        lines.push(`    Inter-msg:   ${formatMs(mux.interMessageMs)}`);
        lines.push("");
      }
    }

    if (bus.bursts.length > 0) {
      lines.push("BURST/TRANSACTION FRAMES");
      lines.push(thinDivider);
      for (const burst of bus.bursts) {
        lines.push(`  ${format(burst)}`);
        lines.push(`    Lengths:     ${burst.lengths.join(", ")}`);
        lines.push(`    Burst Size:  ${burstSize(burst.framesPerBurst)}`);
        lines.push(`    Cycle:       ${formatMs(burst.burstPeriodMs)}`);
        if (burst.flags.length > 0) {
          lines.push(`    Flags:       ${burst.flags.join(", ")}`);
        }
        lines.push("");
      }
    }

    if (bus.intervalGroups.length > 0) {
      lines.push("REPETITION PERIOD GROUPS");
      lines.push(thinDivider);
      for (const group of bus.intervalGroups) {
        lines.push(`  ~${formatMs(group.intervalMs)} (${group.keys.length} frames)`);
        lines.push(`    ${group.keys.map(format).join(", ")}`);
        lines.push("");
      }
    }

    if (bus.startCandidates.length > 0) {
      lines.push("START ID CANDIDATES");
      lines.push(thinDivider);
      lines.push("  Frame ID     Max Gap    Avg Gap    Min Gap    Count");
      lines.push("  " + "-".repeat(55));
      for (const candidate of bus.startCandidates.slice(0, MAX_CANDIDATES)) {
        const id = format(candidate).padEnd(10);
        const max = formatMs(candidate.maxGapBeforeMs).padStart(10);
        const avg = formatMs(candidate.avgGapBeforeMs).padStart(10);
        const min = formatMs(candidate.minGapBeforeMs).padStart(10);
        const n = String(candidate.occurrences).padStart(8);
        lines.push(`  ${id}${max}${avg}${min}${n}`);
      }
      lines.push("");
    }
  }

  if (r.multiBus.length > 0) {
    lines.push("MULTI-BUS FRAMES");
    lines.push(thinDivider);
    for (const { format, frame } of r.multiBus) {
      const busInfo = busCounts(frame).map(([b, n]) => `Bus ${b}: ${n}`).join(", ");
      lines.push(`  ${format(frame)}: ${busInfo}`);
    }
    lines.push("");
  }

  lines.push(divider);
  lines.push("  Generated by WireTAP");
  lines.push(divider);

  return lines.join("\n");
}

// ============================================================================
// Markdown Report
// ============================================================================

function generateMarkdownReport(r: Report): string {
  const lines: string[] = [];

  lines.push("# Frame Order Analysis Report");
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total Frames | ${r.totalFrames.toLocaleString()} |`);
  lines.push(`| Unique Frame IDs | ${r.uniqueKeys} |`);
  lines.push(`| Time Span | ${formatMs(r.timeSpanMs)} |`);
  const patterns = r.buses.reduce((n, b) => n + b.bus.patterns.length, 0);
  if (patterns > 0) lines.push(`| Detected Patterns | ${patterns} |`);
  if (r.multiBus.length > 0) lines.push(`| Multi-Bus Frames | ${r.multiBus.length} |`);
  lines.push("");

  for (const { title, format, bus } of r.buses) {
    lines.push(`## ${title} (${bus.frameCount.toLocaleString()} frames)`);
    lines.push("");

    bus.patterns.forEach((pattern, i) => {
      lines.push(`### Pattern ${i + 1}`);
      lines.push("");
      lines.push(`- **Start ID**: \`${format(pattern.start)}\``);
      lines.push(`- **Sequence**: ${pattern.sequence.map((k) => `\`${format(k)}\``).join(" → ")}`);
      lines.push(`- **Occurrences**: ${pattern.occurrences}`);
      lines.push(`- **Confidence**: ${Math.round(pattern.confidence * 100)}%`);
      lines.push(`- **Cycle**: ${formatOptionalMs(pattern.cycleMs)}`);
      lines.push("");
    });

    if (bus.mux.length > 0) {
      lines.push("### Multiplexed Frames");
      lines.push("");
      lines.push("| Frame ID | Selector | Cases | Mux Period | Inter-msg |");
      lines.push("|----------|----------|-------|------------|-----------|");
      for (const mux of bus.mux) {
        const { shown, more } = muxCases(mux, 8);
        lines.push(`| \`${format(mux)}\` | ${selectorText(mux)} | ${shown.join(", ")}${more ? "..." : ""} | ${formatOptionalMs(mux.muxPeriodMs)} | ${formatMs(mux.interMessageMs)} |`);
      }
      lines.push("");
    }

    if (bus.bursts.length > 0) {
      lines.push("### Burst/Transaction Frames");
      lines.push("");
      lines.push("| Frame ID | Lengths | Burst Size | Cycle | Flags |");
      lines.push("|----------|---------|------------|-------|-------|");
      for (const burst of bus.bursts) {
        lines.push(`| \`${format(burst)}\` | ${burst.lengths.join(", ")} | ${burstSize(burst.framesPerBurst)} | ${formatMs(burst.burstPeriodMs)} | ${burst.flags.join(", ") || "—"} |`);
      }
      lines.push("");
    }

    if (bus.intervalGroups.length > 0) {
      lines.push("### Repetition Period Groups");
      lines.push("");
      for (const group of bus.intervalGroups) {
        lines.push(`- **~${formatMs(group.intervalMs)}** (${group.keys.length} frames): ${group.keys.map((k) => `\`${format(k)}\``).join(", ")}`);
      }
      lines.push("");
    }

    if (bus.startCandidates.length > 0) {
      lines.push("### Start ID Candidates");
      lines.push("");
      lines.push("| Frame ID | Max Gap | Avg Gap | Min Gap | Count |");
      lines.push("|----------|---------|---------|---------|-------|");
      for (const c of bus.startCandidates.slice(0, MAX_CANDIDATES)) {
        lines.push(`| \`${format(c)}\` | ${formatMs(c.maxGapBeforeMs)} | ${formatMs(c.avgGapBeforeMs)} | ${formatMs(c.minGapBeforeMs)} | ${c.occurrences} |`);
      }
      lines.push("");
    }
  }

  if (r.multiBus.length > 0) {
    lines.push("## Multi-Bus Frames");
    lines.push("");
    lines.push("| Frame ID | Count per Bus |");
    lines.push("|----------|---------------|");
    for (const { format, frame } of r.multiBus) {
      lines.push(`| \`${format(frame)}\` | ${busCounts(frame).map(([b, n]) => `Bus ${b}: ${n}`).join(", ")} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("*Generated by WireTAP*");

  return lines.join("\n");
}

// ============================================================================
// HTML Reports
// ============================================================================

type HtmlStyle = {
  styles: string;
  card: string;
  badge: (tone: string, text: string) => string;
  id: (text: string) => string;
};

const SCREEN: HtmlStyle = {
  styles: DARK_THEME_STYLES,
  card: 'section-card',
  badge: (tone, text) => `<span class="badge badge-${tone}">${text}</span>`,
  id: (text) => `<span class="frame-id">${text}</span>`,
};

const PRINT: HtmlStyle = {
  styles: PRINT_THEME_STYLES,
  card: 'section-card no-break',
  badge: (tone, text) => `<span class="badge badge-${tone}">${text}</span>`,
  id: (text) => `<code>${text}</code>`,
};

function busHtml({ title, format, bus }: Bus, s: HtmlStyle): string {
  let html = `<h2>${title} (${bus.frameCount.toLocaleString()} frames)</h2>`;

  bus.patterns.forEach((pattern, i) => {
    html += `
    <div class="${s.card}">
      <div><strong>Pattern #${i + 1}</strong> — starts with ${s.id(format(pattern.start))} · ${Math.round(pattern.confidence * 100)}% consistent</div>
      <div>${pattern.sequence.map((k, idx) => s.badge(idx === 0 ? 'purple' : 'slate', format(k))).join(' ')}</div>
      <div>${pattern.sequence.length} frames • ${pattern.occurrences}× seen • cycle: ${formatOptionalMs(pattern.cycleMs)}</div>
    </div>`;
  });

  if (bus.mux.length > 0) {
    html += `<h3>Multiplexed Frames</h3>
    <table>
      <tr><th>Frame ID</th><th>Selector</th><th>Cases</th><th>Mux Period</th><th>Inter-msg</th></tr>`;
    for (const mux of bus.mux) {
      const { shown, more } = muxCases(mux, 8);
      html += `
      <tr><td>${s.id(format(mux))}</td><td>${selectorText(mux)}</td><td>${shown.map((v) => s.badge('orange', v)).join(' ')}${more ? '...' : ''}</td><td>${formatOptionalMs(mux.muxPeriodMs)}</td><td>${formatMs(mux.interMessageMs)}</td></tr>`;
    }
    html += `</table>`;
  }

  if (bus.bursts.length > 0) {
    html += `<h3>Burst/Transaction Frames</h3>
    <table>
      <tr><th>Frame ID</th><th>Lengths</th><th>Burst Size</th><th>Cycle</th><th>Flags</th></tr>`;
    for (const burst of bus.bursts) {
      html += `
      <tr><td>${s.id(format(burst))}</td><td>${burst.lengths.map((n) => s.badge('cyan', String(n))).join(' ')}</td><td>${burstSize(burst.framesPerBurst)}</td><td>${formatMs(burst.burstPeriodMs)}</td><td>${burst.flags.map((f) => s.badge('slate', f)).join(' ') || '—'}</td></tr>`;
    }
    html += `</table>`;
  }

  if (bus.intervalGroups.length > 0) {
    html += `<h3>Repetition Period Groups</h3>`;
    for (const group of bus.intervalGroups) {
      html += `
    <div class="${s.card}">
      <div><strong>~${formatMs(group.intervalMs)}</strong> (${group.keys.length} frames)</div>
      <div>${group.keys.map((k) => s.badge('slate', format(k))).join(' ')}</div>
    </div>`;
    }
  }

  if (bus.startCandidates.length > 0) {
    html += `<h3>Start ID Candidates</h3>
    <table>
      <tr><th>Frame ID</th><th>Max Gap</th><th>Avg Gap</th><th>Min Gap</th><th>Count</th></tr>`;
    for (const c of bus.startCandidates.slice(0, MAX_CANDIDATES)) {
      html += `
      <tr><td>${s.id(format(c))}</td><td>${formatMs(c.maxGapBeforeMs)}</td><td>${formatMs(c.avgGapBeforeMs)}</td><td>${formatMs(c.minGapBeforeMs)}</td><td>${c.occurrences}</td></tr>`;
    }
    html += `</table>`;
  }

  return html;
}

function htmlReport(r: Report, s: HtmlStyle, preamble: string): string {
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Frame Order Analysis Report</title>
  <style>${s.styles}</style>
</head>
<body>
  <div class="container">
    <h1>Frame Order Analysis Report</h1>
    ${preamble}
    <div class="summary-grid">
      <div class="summary-card stat-item"><div class="value">${r.totalFrames.toLocaleString()}</div><div class="label">Total Frames</div></div>
      <div class="summary-card stat-item"><div class="value">${r.uniqueKeys}</div><div class="label">Unique IDs</div></div>
      <div class="summary-card stat-item"><div class="value">${formatMs(r.timeSpanMs)}</div><div class="label">Time Span</div></div>
      <div class="summary-card stat-item"><div class="value">${r.buses.length}</div><div class="label">Buses</div></div>
    </div>
`;

  html += r.buses.map((bus) => busHtml(bus, s)).join('\n');

  if (r.multiBus.length > 0) {
    html += `<h2>Multi-Bus Frames</h2>
    <table>
      <tr><th>Frame ID</th><th>Count per Bus</th></tr>`;
    for (const { format, frame } of r.multiBus) {
      html += `
      <tr><td>${s.id(format(frame))}</td><td>${busCounts(frame).map(([b, n]) => s.badge('pink', `Bus ${b}: ${n}`)).join(' ')}</td></tr>`;
    }
    html += `</table>`;
  }

  html += `
    <div class="footer">Generated by WireTAP</div>
  </div>
</body>
</html>`;

  return html;
}

function generateHtmlReport(r: Report): string {
  return htmlReport(r, SCREEN, '');
}

function generatePrintReport(r: Report): string {
  return htmlReport(
    r,
    PRINT,
    `<div class="print-instructions">
      <strong>To save as PDF:</strong> Use your browser's Print function (Ctrl+P / Cmd+P) and select "Save as PDF" as the destination.
    </div>`
  );
}

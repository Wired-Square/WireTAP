// ui/src/utils/frameOrderReport.ts
// Report generation for Frame Order analysis results

import type { MessageOrderResult } from './analysis/messageOrderAnalysis';
import type { ExportFormat } from './reportExport';
import { formatMs, DARK_THEME_STYLES, PRINT_THEME_STYLES } from './reportExport';
import { formatFrameId } from './frameIds';

/**
 * Generate report content for Frame Order analysis
 */
export function generateFrameOrderReport(results: MessageOrderResult, format: ExportFormat): string {
  switch (format) {
    case "text":
      return generateTextReport(results);
    case "markdown":
      return generateMarkdownReport(results);
    case "html-screen":
      return generateHtmlReport(results);
    case "html-print":
      return generatePrintReport(results);
    case "json":
      return JSON.stringify(results, null, 2);
  }
}

// ============================================================================
// Text Report
// ============================================================================

function generateTextReport(results: MessageOrderResult): string {
  const lines: string[] = [];
  const divider = "═".repeat(70);
  const thinDivider = "─".repeat(70);

  lines.push(divider);
  lines.push("  FRAME ORDER ANALYSIS REPORT");
  lines.push(divider);
  lines.push("");

  // Summary
  lines.push("SUMMARY");
  lines.push(thinDivider);
  lines.push(`  Total Frames Analyzed: ${results.totalFramesAnalyzed.toLocaleString()}`);
  lines.push(`  Unique Frame IDs:      ${results.uniqueFrameIds}`);
  lines.push(`  Time Span:             ${formatMs(results.timeSpanMs)}`);
  lines.push("");

  // Quick stats
  if (results.patterns.length > 0) lines.push(`  Detected Patterns:     ${results.patterns.length}`);
  if (results.multiplexedFrames.length > 0) lines.push(`  Multiplexed Frames:    ${results.multiplexedFrames.length}`);
  if (results.burstFrames.length > 0) lines.push(`  Burst/Transaction:     ${results.burstFrames.length}`);
  if (results.multiBusFrames.length > 0) lines.push(`  Multi-Bus Frames:      ${results.multiBusFrames.length}`);
  if (results.intervalGroups.length > 0) lines.push(`  Interval Groups:       ${results.intervalGroups.length}`);
  lines.push("");

  // Detected Patterns
  if (results.patterns.length > 0) {
    lines.push("DETECTED PATTERNS");
    lines.push(thinDivider);
    for (let i = 0; i < results.patterns.length; i++) {
      const pattern = results.patterns[i];
      lines.push(`  Pattern #${i + 1}`);
      lines.push(`    Start ID:    ${formatFrameId(pattern.startId)}`);
      lines.push(`    Sequence:    ${pattern.sequence.map((id) => formatFrameId(id)).join(" → ")}`);
      lines.push(`    Occurrences: ${pattern.occurrences}`);
      lines.push(`    Confidence:  ${Math.round(pattern.confidence * 100)}%`);
      lines.push(`    Avg Cycle:   ${formatMs(pattern.avgCycleTimeMs)}`);
      lines.push("");
    }
  }

  // Multiplexed Frames
  if (results.multiplexedFrames.length > 0) {
    lines.push("MULTIPLEXED FRAMES");
    lines.push(thinDivider);
    for (const mux of results.multiplexedFrames) {
      const selector = mux.selectorByte === -1 ? "byte[0:1]" : `byte[${mux.selectorByte}]`;
      const cases = mux.selectorByte === -1
        ? mux.selectorValues.map(v => `${Math.floor(v / 256)}.${v % 256}`).join(", ")
        : mux.selectorValues.join(", ");
      lines.push(`  ${formatFrameId(mux.frameId)}`);
      lines.push(`    Selector:    ${selector}`);
      lines.push(`    Cases:       ${cases}`);
      lines.push(`    Mux Period:  ${formatMs(mux.muxPeriodMs)}`);
      lines.push(`    Inter-msg:   ${formatMs(mux.interMessageMs)}`);
      lines.push("");
    }
  }

  // Burst Frames
  if (results.burstFrames.length > 0) {
    lines.push("BURST/TRANSACTION FRAMES");
    lines.push(thinDivider);
    for (const burst of results.burstFrames) {
      lines.push(`  ${formatFrameId(burst.frameId)}`);
      lines.push(`    DLCs:        ${burst.dlcVariation.join(", ")}`);
      lines.push(`    Burst Size:  ${burst.burstCount === 1 ? "—" : `~${burst.burstCount}`}`);
      lines.push(`    Cycle:       ${formatMs(burst.burstPeriodMs)}`);
      if (burst.flags.length > 0) {
        lines.push(`    Flags:       ${burst.flags.join(", ")}`);
      }
      lines.push("");
    }
  }

  // Multi-Bus Frames
  if (results.multiBusFrames.length > 0) {
    lines.push("MULTI-BUS FRAMES");
    lines.push(thinDivider);
    for (const frame of results.multiBusFrames) {
      const busInfo = frame.buses.map(b => `Bus ${b}: ${frame.countPerBus[b]}`).join(", ");
      lines.push(`  ${formatFrameId(frame.frameId)}: ${busInfo}`);
    }
    lines.push("");
  }

  // Interval Groups
  if (results.intervalGroups.length > 0) {
    lines.push("REPETITION PERIOD GROUPS");
    lines.push(thinDivider);
    for (const group of results.intervalGroups) {
      lines.push(`  ~${formatMs(group.intervalMs)} (${group.frameIds.length} frames)`);
      lines.push(`    ${group.frameIds.map((id) => formatFrameId(id)).join(", ")}`);
      lines.push("");
    }
  }

  // Start ID Candidates
  if (results.startIdCandidates.length > 0) {
    lines.push("START ID CANDIDATES");
    lines.push(thinDivider);
    lines.push("  Frame ID     Max Gap    Avg Gap    Min Gap    Count");
    lines.push("  " + "-".repeat(55));
    for (const candidate of results.startIdCandidates.slice(0, 10)) {
      const id = formatFrameId(candidate.id).padEnd(10);
      const max = formatMs(candidate.maxGapBeforeMs).padStart(10);
      const avg = formatMs(candidate.avgGapBeforeMs).padStart(10);
      const min = formatMs(candidate.minGapBeforeMs).padStart(10);
      const count = String(candidate.occurrences).padStart(8);
      lines.push(`  ${id}${max}${avg}${min}${count}`);
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

function generateMarkdownReport(results: MessageOrderResult): string {
  const lines: string[] = [];

  lines.push("# Frame Order Analysis Report");
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total Frames | ${results.totalFramesAnalyzed.toLocaleString()} |`);
  lines.push(`| Unique Frame IDs | ${results.uniqueFrameIds} |`);
  lines.push(`| Time Span | ${formatMs(results.timeSpanMs)} |`);
  if (results.patterns.length > 0) lines.push(`| Detected Patterns | ${results.patterns.length} |`);
  if (results.multiplexedFrames.length > 0) lines.push(`| Multiplexed Frames | ${results.multiplexedFrames.length} |`);
  if (results.burstFrames.length > 0) lines.push(`| Burst/Transaction | ${results.burstFrames.length} |`);
  if (results.multiBusFrames.length > 0) lines.push(`| Multi-Bus Frames | ${results.multiBusFrames.length} |`);
  lines.push("");

  // Detected Patterns
  if (results.patterns.length > 0) {
    lines.push("## Detected Patterns");
    lines.push("");
    for (let i = 0; i < results.patterns.length; i++) {
      const pattern = results.patterns[i];
      lines.push(`### Pattern ${i + 1}`);
      lines.push("");
      lines.push(`- **Start ID**: \`${formatFrameId(pattern.startId)}\``);
      lines.push(`- **Sequence**: ${pattern.sequence.map(id => `\`${formatFrameId(id)}\``).join(" → ")}`);
      lines.push(`- **Occurrences**: ${pattern.occurrences}`);
      lines.push(`- **Confidence**: ${Math.round(pattern.confidence * 100)}%`);
      lines.push(`- **Avg Cycle**: ${formatMs(pattern.avgCycleTimeMs)}`);
      lines.push("");
    }
  }

  // Multiplexed Frames
  if (results.multiplexedFrames.length > 0) {
    lines.push("## Multiplexed Frames");
    lines.push("");
    lines.push("| Frame ID | Selector | Cases | Mux Period | Inter-msg |");
    lines.push("|----------|----------|-------|------------|-----------|");
    for (const mux of results.multiplexedFrames) {
      const selector = mux.selectorByte === -1 ? "byte[0:1]" : `byte[${mux.selectorByte}]`;
      const cases = mux.selectorByte === -1
        ? mux.selectorValues.slice(0, 5).map(v => `${Math.floor(v / 256)}.${v % 256}`).join(", ") + (mux.selectorValues.length > 5 ? "..." : "")
        : mux.selectorValues.slice(0, 8).join(", ") + (mux.selectorValues.length > 8 ? "..." : "");
      lines.push(`| \`${formatFrameId(mux.frameId)}\` | ${selector} | ${cases} | ${formatMs(mux.muxPeriodMs)} | ${formatMs(mux.interMessageMs)} |`);
    }
    lines.push("");
  }

  // Burst Frames
  if (results.burstFrames.length > 0) {
    lines.push("## Burst/Transaction Frames");
    lines.push("");
    lines.push("| Frame ID | DLCs | Burst Size | Cycle | Flags |");
    lines.push("|----------|------|------------|-------|-------|");
    for (const burst of results.burstFrames) {
      const size = burst.burstCount === 1 ? "—" : `~${burst.burstCount}`;
      lines.push(`| \`${formatFrameId(burst.frameId)}\` | ${burst.dlcVariation.join(", ")} | ${size} | ${formatMs(burst.burstPeriodMs)} | ${burst.flags.join(", ") || "—"} |`);
    }
    lines.push("");
  }

  // Multi-Bus Frames
  if (results.multiBusFrames.length > 0) {
    lines.push("## Multi-Bus Frames");
    lines.push("");
    lines.push("| Frame ID | Buses | Count per Bus |");
    lines.push("|----------|-------|---------------|");
    for (const frame of results.multiBusFrames) {
      const buses = frame.buses.map(b => `Bus ${b}`).join(", ");
      const counts = frame.buses.map(b => `${b}: ${frame.countPerBus[b]}`).join(", ");
      lines.push(`| \`${formatFrameId(frame.frameId)}\` | ${buses} | ${counts} |`);
    }
    lines.push("");
  }

  // Interval Groups
  if (results.intervalGroups.length > 0) {
    lines.push("## Repetition Period Groups");
    lines.push("");
    for (const group of results.intervalGroups) {
      lines.push(`### ~${formatMs(group.intervalMs)} (${group.frameIds.length} frames)`);
      lines.push("");
      lines.push(group.frameIds.map(id => `\`${formatFrameId(id)}\``).join(", "));
      lines.push("");
    }
  }

  // Start ID Candidates
  if (results.startIdCandidates.length > 0) {
    lines.push("## Start ID Candidates");
    lines.push("");
    lines.push("| Frame ID | Max Gap | Avg Gap | Min Gap | Count |");
    lines.push("|----------|---------|---------|---------|-------|");
    for (const candidate of results.startIdCandidates.slice(0, 10)) {
      lines.push(`| \`${formatFrameId(candidate.id)}\` | ${formatMs(candidate.maxGapBeforeMs)} | ${formatMs(candidate.avgGapBeforeMs)} | ${formatMs(candidate.minGapBeforeMs)} | ${candidate.occurrences} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("*Generated by WireTAP*");

  return lines.join("\n");
}

// ============================================================================
// HTML Report (Screen)
// ============================================================================

function generateHtmlReport(results: MessageOrderResult): string {
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Frame Order Analysis Report</title>
  <style>${DARK_THEME_STYLES}</style>
</head>
<body>
  <div class="container">
    <h1>Frame Order Analysis Report</h1>

    <div class="summary-grid">
      <div class="summary-card">
        <div class="value">${results.totalFramesAnalyzed.toLocaleString()}</div>
        <div class="label">Total Frames</div>
      </div>
      <div class="summary-card">
        <div class="value">${results.uniqueFrameIds}</div>
        <div class="label">Unique IDs</div>
      </div>
      <div class="summary-card">
        <div class="value">${formatMs(results.timeSpanMs)}</div>
        <div class="label">Time Span</div>
      </div>
      ${results.patterns.length > 0 ? `<div class="summary-card"><div class="value">${results.patterns.length}</div><div class="label">Patterns</div></div>` : ''}
    </div>

    <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0;">
      ${results.patterns.length > 0 ? '<span class="badge badge-purple">Patterns Detected</span>' : ''}
      ${results.multiplexedFrames.length > 0 ? '<span class="badge badge-orange">Multiplexed</span>' : ''}
      ${results.burstFrames.length > 0 ? '<span class="badge badge-cyan">Burst/Transaction</span>' : ''}
      ${results.multiBusFrames.length > 0 ? '<span class="badge badge-pink">Multi-Bus</span>' : ''}
    </div>
`;

  // Detected Patterns
  if (results.patterns.length > 0) {
    html += `<h2>Detected Patterns</h2>`;
    for (let i = 0; i < results.patterns.length; i++) {
      const pattern = results.patterns[i];
      const confidence = Math.round(pattern.confidence * 100);
      const isHigh = pattern.confidence >= 0.8;
      html += `
    <div class="section-card">
      <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
        <span><strong>Pattern #${i + 1}</strong> — starts with <span class="frame-id">${formatFrameId(pattern.startId)}</span></span>
        <span style="color: ${isHigh ? 'var(--accent-green)' : 'var(--accent-yellow)'};">${confidence}% consistent</span>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.5rem 0;">
        ${pattern.sequence.map((id, idx) => `<span class="badge ${idx === 0 ? 'badge-purple' : 'badge-slate'}">${formatFrameId(id)}</span>`).join('')}
      </div>
      <div style="color: var(--text-secondary); font-size: 0.875rem;">
        ${pattern.sequence.length} frames • ${pattern.occurrences}× seen • avg cycle: ${formatMs(pattern.avgCycleTimeMs)}
      </div>
    </div>`;
    }
  }

  // Multiplexed Frames
  if (results.multiplexedFrames.length > 0) {
    html += `<h2>Multiplexed Frames</h2>
    <div class="section-card">
      <table>
        <tr><th>Frame ID</th><th>Selector</th><th>Cases</th><th>Mux Period</th><th>Inter-msg</th></tr>`;
    for (const mux of results.multiplexedFrames) {
      const selector = mux.selectorByte === -1 ? "byte[0:1]" : `byte[${mux.selectorByte}]`;
      const cases = mux.selectorByte === -1
        ? mux.selectorValues.slice(0, 5).map(v => `<span class="badge badge-orange">${Math.floor(v / 256)}.${v % 256}</span>`).join(' ')
        : mux.selectorValues.slice(0, 8).map(v => `<span class="badge badge-orange">${v}</span>`).join(' ');
      html += `
        <tr>
          <td class="frame-id">${formatFrameId(mux.frameId)}</td>
          <td>${selector}</td>
          <td>${cases}${mux.selectorValues.length > 8 ? '...' : ''}</td>
          <td style="color: var(--accent-green);">${formatMs(mux.muxPeriodMs)}</td>
          <td style="color: var(--text-secondary);">${formatMs(mux.interMessageMs)}</td>
        </tr>`;
    }
    html += `</table></div>`;
  }

  // Burst Frames
  if (results.burstFrames.length > 0) {
    html += `<h2>Burst/Transaction Frames</h2>
    <div class="section-card">
      <table>
        <tr><th>Frame ID</th><th>DLCs</th><th>Burst Size</th><th>Cycle</th><th>Flags</th></tr>`;
    for (const burst of results.burstFrames) {
      const dlcs = burst.dlcVariation.map(d => `<span class="badge badge-cyan">${d}</span>`).join(' ');
      const flags = burst.flags.map(f => `<span class="badge badge-slate">${f}</span>`).join(' ') || '—';
      html += `
        <tr>
          <td class="frame-id">${formatFrameId(burst.frameId)}</td>
          <td>${dlcs}</td>
          <td>${burst.burstCount === 1 ? '—' : `~${burst.burstCount}`}</td>
          <td style="color: var(--accent-green);">${formatMs(burst.burstPeriodMs)}</td>
          <td>${flags}</td>
        </tr>`;
    }
    html += `</table></div>`;
  }

  // Multi-Bus Frames
  if (results.multiBusFrames.length > 0) {
    html += `<h2>Multi-Bus Frames</h2>
    <div class="section-card">
      <table>
        <tr><th>Frame ID</th><th>Buses</th><th>Count per Bus</th></tr>`;
    for (const frame of results.multiBusFrames) {
      const buses = frame.buses.map(b => `<span class="badge badge-pink">Bus ${b}</span>`).join(' ');
      const counts = frame.buses.map(b => `<span class="badge badge-slate">${b}: ${frame.countPerBus[b]}</span>`).join(' ');
      html += `
        <tr>
          <td class="frame-id">${formatFrameId(frame.frameId)}</td>
          <td>${buses}</td>
          <td>${counts}</td>
        </tr>`;
    }
    html += `</table></div>`;
  }

  // Interval Groups
  if (results.intervalGroups.length > 0) {
    html += `<h2>Repetition Period Groups</h2>`;
    for (const group of results.intervalGroups) {
      html += `
    <div class="section-card">
      <div style="margin-bottom: 0.5rem;">
        <span style="color: var(--accent-green); font-weight: bold;">~${formatMs(group.intervalMs)}</span>
        <span style="color: var(--text-secondary);"> (${group.frameIds.length} frames)</span>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 0.25rem;">
        ${group.frameIds.map(id => `<span class="badge badge-slate">${formatFrameId(id)}</span>`).join('')}
      </div>
    </div>`;
    }
  }

  // Start ID Candidates
  if (results.startIdCandidates.length > 0) {
    html += `<h2>Start ID Candidates</h2>
    <div class="section-card">
      <table>
        <tr><th>Frame ID</th><th>Max Gap</th><th>Avg Gap</th><th>Min Gap</th><th>Count</th></tr>`;
    for (const candidate of results.startIdCandidates.slice(0, 10)) {
      html += `
        <tr>
          <td class="frame-id">${formatFrameId(candidate.id)}</td>
          <td>${formatMs(candidate.maxGapBeforeMs)}</td>
          <td style="color: var(--text-secondary);">${formatMs(candidate.avgGapBeforeMs)}</td>
          <td style="color: var(--text-secondary);">${formatMs(candidate.minGapBeforeMs)}</td>
          <td style="color: var(--text-secondary);">${candidate.occurrences}</td>
        </tr>`;
    }
    html += `</table></div>`;
  }

  html += `
    <div class="footer">Generated by WireTAP</div>
  </div>
</body>
</html>`;

  return html;
}

// ============================================================================
// HTML Report (Print)
// ============================================================================

function generatePrintReport(results: MessageOrderResult): string {
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Frame Order Analysis Report</title>
  <style>${PRINT_THEME_STYLES}</style>
</head>
<body>
  <h1>Frame Order Analysis Report</h1>

  <div class="print-instructions">
    <strong>To save as PDF:</strong> Use your browser's Print function (Ctrl+P / Cmd+P) and select "Save as PDF" as the destination.
  </div>

  <div class="summary-box">
    <div class="summary-grid">
      <div class="stat-item">
        <div class="value">${results.totalFramesAnalyzed.toLocaleString()}</div>
        <div class="label">Total Frames</div>
      </div>
      <div class="stat-item">
        <div class="value">${results.uniqueFrameIds}</div>
        <div class="label">Unique IDs</div>
      </div>
      <div class="stat-item">
        <div class="value">${formatMs(results.timeSpanMs)}</div>
        <div class="label">Time Span</div>
      </div>
      ${results.patterns.length > 0 ? `<div class="stat-item"><div class="value">${results.patterns.length}</div><div class="label">Patterns</div></div>` : ''}
    </div>
  </div>
`;

  // Detected Patterns
  if (results.patterns.length > 0) {
    html += `<h2>Detected Patterns</h2>`;
    for (let i = 0; i < results.patterns.length; i++) {
      const pattern = results.patterns[i];
      const confidence = Math.round(pattern.confidence * 100);
      html += `
  <div class="section-card no-break">
    <div style="display: flex; justify-content: space-between; margin-bottom: 6pt;">
      <span><strong>Pattern #${i + 1}</strong> — starts with <span class="frame-id">${formatFrameId(pattern.startId)}</span></span>
      <span>${confidence}% consistent</span>
    </div>
    <div style="margin: 4pt 0;">
      ${pattern.sequence.map((id, idx) => `<span class="badge ${idx === 0 ? 'badge-purple' : 'badge-slate'}">${formatFrameId(id)}</span>`).join(' ')}
    </div>
    <div style="font-size: 9pt; color: var(--text-secondary);">
      ${pattern.sequence.length} frames • ${pattern.occurrences}× seen • avg cycle: ${formatMs(pattern.avgCycleTimeMs)}
    </div>
  </div>`;
    }
  }

  // Multiplexed Frames
  if (results.multiplexedFrames.length > 0) {
    html += `<h2>Multiplexed Frames</h2>
  <table>
    <tr><th>Frame ID</th><th>Selector</th><th>Cases</th><th>Mux Period</th><th>Inter-msg</th></tr>`;
    for (const mux of results.multiplexedFrames) {
      const selector = mux.selectorByte === -1 ? "byte[0:1]" : `byte[${mux.selectorByte}]`;
      const cases = mux.selectorByte === -1
        ? mux.selectorValues.slice(0, 5).map(v => `${Math.floor(v / 256)}.${v % 256}`).join(", ")
        : mux.selectorValues.slice(0, 8).join(", ");
      html += `
    <tr>
      <td><code>${formatFrameId(mux.frameId)}</code></td>
      <td>${selector}</td>
      <td>${cases}${mux.selectorValues.length > 8 ? '...' : ''}</td>
      <td>${formatMs(mux.muxPeriodMs)}</td>
      <td>${formatMs(mux.interMessageMs)}</td>
    </tr>`;
    }
    html += `</table>`;
  }

  // Burst Frames
  if (results.burstFrames.length > 0) {
    html += `<h2>Burst/Transaction Frames</h2>
  <table>
    <tr><th>Frame ID</th><th>DLCs</th><th>Burst Size</th><th>Cycle</th><th>Flags</th></tr>`;
    for (const burst of results.burstFrames) {
      html += `
    <tr>
      <td><code>${formatFrameId(burst.frameId)}</code></td>
      <td>${burst.dlcVariation.join(", ")}</td>
      <td>${burst.burstCount === 1 ? '—' : `~${burst.burstCount}`}</td>
      <td>${formatMs(burst.burstPeriodMs)}</td>
      <td>${burst.flags.join(", ") || '—'}</td>
    </tr>`;
    }
    html += `</table>`;
  }

  // Multi-Bus Frames
  if (results.multiBusFrames.length > 0) {
    html += `<h2>Multi-Bus Frames</h2>
  <table>
    <tr><th>Frame ID</th><th>Buses</th><th>Count per Bus</th></tr>`;
    for (const frame of results.multiBusFrames) {
      const buses = frame.buses.map(b => `Bus ${b}`).join(", ");
      const counts = frame.buses.map(b => `${b}: ${frame.countPerBus[b]}`).join(", ");
      html += `
    <tr>
      <td><code>${formatFrameId(frame.frameId)}</code></td>
      <td>${buses}</td>
      <td>${counts}</td>
    </tr>`;
    }
    html += `</table>`;
  }

  // Interval Groups
  if (results.intervalGroups.length > 0) {
    html += `<h2>Repetition Period Groups</h2>`;
    for (const group of results.intervalGroups) {
      html += `
  <div class="section-card no-break">
    <div style="margin-bottom: 4pt;">
      <strong>~${formatMs(group.intervalMs)}</strong>
      <span style="color: var(--text-secondary);"> (${group.frameIds.length} frames)</span>
    </div>
    <div>
      ${group.frameIds.map(id => `<code>${formatFrameId(id)}</code>`).join(' ')}
    </div>
  </div>`;
    }
  }

  // Start ID Candidates
  if (results.startIdCandidates.length > 0) {
    html += `<h2>Start ID Candidates</h2>
  <table>
    <tr><th>Frame ID</th><th>Max Gap</th><th>Avg Gap</th><th>Min Gap</th><th>Count</th></tr>`;
    for (const candidate of results.startIdCandidates.slice(0, 10)) {
      html += `
    <tr>
      <td><code>${formatFrameId(candidate.id)}</code></td>
      <td>${formatMs(candidate.maxGapBeforeMs)}</td>
      <td>${formatMs(candidate.avgGapBeforeMs)}</td>
      <td>${formatMs(candidate.minGapBeforeMs)}</td>
      <td>${candidate.occurrences}</td>
    </tr>`;
    }
    html += `</table>`;
  }

  html += `
  <div class="footer">Generated by WireTAP</div>
</body>
</html>`;

  return html;
}

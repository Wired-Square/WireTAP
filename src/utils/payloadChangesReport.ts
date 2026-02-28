// ui/src/utils/payloadChangesReport.ts
// Report generation for Payload Changes analysis

import type { ChangesResult } from "../stores/discoveryStore";
import { type ExportFormat, DARK_THEME_STYLES, PRINT_THEME_STYLES } from "./reportExport";
import { formatFrameId } from "./frameIds";

/**
 * Generate a report for Payload Changes analysis in the specified format
 */
export function generatePayloadChangesReport(results: ChangesResult, format: ExportFormat): string {
  switch (format) {
    case "text":
      return generateTextReport(results);
    case "markdown":
      return generateMarkdownReport(results);
    case "html-screen":
      return generateHtmlReport(results);
    case "html-print":
      return generatePdfReadyReport(results);
    case "json":
      return JSON.stringify(results, null, 2);
  }
}

// ============================================================================
// Text Report Generation
// ============================================================================

function generateTextReport(results: ChangesResult): string {
  const lines: string[] = [];
  const divider = "═".repeat(70);
  const thinDivider = "─".repeat(70);

  // Header
  lines.push(divider);
  lines.push("  CAN PAYLOAD ANALYSIS REPORT");
  lines.push(divider);
  lines.push("");

  // Summary
  lines.push("SUMMARY");
  lines.push(thinDivider);
  lines.push(`  Total Frames Analyzed: ${results.frameCount.toLocaleString()}`);
  lines.push(`  Unique Frame IDs:      ${results.uniqueFrameIds}`);
  lines.push("");

  // Quick stats
  const identicalCount = results.analysisResults.filter(r => r.isIdentical).length;
  const varyingLengthCount = results.analysisResults.filter(r => r.hasVaryingLength).length;
  const muxCount = results.analysisResults.filter(r => r.isMuxFrame).length;
  const burstCount = results.analysisResults.filter(r => r.isBurstFrame).length;
  const mirrorCount = results.mirrorGroups?.length ?? 0;

  if (mirrorCount > 0) lines.push(`  Mirror Groups:       ${mirrorCount}`);
  if (identicalCount > 0) lines.push(`  Identical Frames:    ${identicalCount}`);
  if (varyingLengthCount > 0) lines.push(`  Varying Length:      ${varyingLengthCount}`);
  if (muxCount > 0) lines.push(`  Multiplexed:         ${muxCount}`);
  if (burstCount > 0) lines.push(`  Burst Frames:        ${burstCount}`);
  lines.push("");

  // Mirror Groups Section
  if (results.mirrorGroups && results.mirrorGroups.length > 0) {
    lines.push("MIRROR FRAMES");
    lines.push(thinDivider);
    lines.push("  These frame IDs transmit identical payloads that change together:");
    lines.push("");

    for (const group of results.mirrorGroups) {
      const ids = group.frameIds.map(id => formatFrameId(id)).join(" <-> ");
      lines.push(`  ${ids}`);
      lines.push(`    Match rate: ${group.matchPercentage}% (${group.sampleCount} matching pairs)`);
      if (group.samplePayload) {
        const hex = group.samplePayload.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        lines.push(`    Sample:     ${hex}`);
      }
      lines.push("");
    }
  }

  // Individual Frame Analysis
  lines.push("FRAME ANALYSIS");
  lines.push(divider);

  const sortedResults = [...results.analysisResults].sort((a, b) => a.frameId - b.frameId);

  for (const result of sortedResults) {
    lines.push("");
    lines.push(`+-- Frame ${formatFrameId(result.frameId)} ` + "-".repeat(50));
    lines.push(`|  Samples: ${result.sampleCount}`);

    // Flags
    const flags: string[] = [];
    if (result.isIdentical) flags.push("Identical");
    if (result.hasVaryingLength && result.lengthRange) {
      flags.push(`Length ${result.lengthRange.min}-${result.lengthRange.max}`);
    }
    if (result.isMuxFrame) flags.push("Multiplexed");
    if (result.isBurstFrame) flags.push("Burst");

    if (flags.length > 0) {
      lines.push(`|  Flags:   ${flags.join(", ")}`);
    }

    // Byte analysis visualization
    if (result.byteStats.length > 0) {
      lines.push("|");
      lines.push("|  Byte Analysis:");
      const byteRow = result.byteStats.map((s) => {
        const role = s.role === 'static' ? '#' : s.role === 'counter' ? '^' : s.role === 'sensor' ? '~' : s.role === 'value' ? '?' : ' ';
        return role;
      }).join('');
      lines.push(`|  [${byteRow}]`);
      lines.push(`|   #=static  ^=counter  ~=sensor  ?=value`);
    }

    // Multi-byte patterns
    if (result.multiBytePatterns && result.multiBytePatterns.length > 0) {
      lines.push("|");
      lines.push("|  Detected Patterns:");
      for (const pattern of result.multiBytePatterns) {
        const range = `byte[${pattern.startByte}:${pattern.startByte + pattern.length - 1}]`;
        let desc = pattern.pattern;
        if (pattern.endianness) desc += ` (${pattern.endianness})`;
        if (pattern.rolloverDetected) desc += " +rollover";
        if (pattern.sampleText) desc += ` "${pattern.sampleText}"`;
        lines.push(`|    ${range}: ${desc}`);
      }
    }

    // Notes
    if (result.notes.length > 0) {
      lines.push("|");
      lines.push("|  Notes:");
      for (const note of result.notes) {
        lines.push(`|    - ${note}`);
      }
    }

    // Mux cases
    if (result.muxCaseAnalyses && result.muxCaseAnalyses.length > 0) {
      lines.push("|");
      lines.push("|  Mux Cases:");
      for (const muxCase of result.muxCaseAnalyses) {
        lines.push(`|    Case 0x${muxCase.muxValue.toString(16).toUpperCase()}: ${muxCase.sampleCount} samples`);
        if (muxCase.notes && muxCase.notes.length > 0) {
          for (const note of muxCase.notes) {
            lines.push(`|      ${note}`);
          }
        }
      }
    }

    lines.push("+" + "-".repeat(60));
  }

  lines.push("");
  lines.push(divider);
  lines.push("  Generated by WireTAP");
  lines.push(divider);

  return lines.join("\n");
}

// ============================================================================
// Markdown Report Generation
// ============================================================================

function generateMarkdownReport(results: ChangesResult): string {
  const lines: string[] = [];

  lines.push("# CAN Bus Payload Analysis Report");
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total Frames | ${results.frameCount.toLocaleString()} |`);
  lines.push(`| Unique Frame IDs | ${results.uniqueFrameIds} |`);

  const identicalCount = results.analysisResults.filter(r => r.isIdentical).length;
  const varyingLengthCount = results.analysisResults.filter(r => r.hasVaryingLength).length;
  const muxCount = results.analysisResults.filter(r => r.isMuxFrame).length;
  const burstCount = results.analysisResults.filter(r => r.isBurstFrame).length;
  const mirrorCount = results.mirrorGroups?.length ?? 0;

  if (mirrorCount > 0) lines.push(`| Mirror Groups | ${mirrorCount} |`);
  if (identicalCount > 0) lines.push(`| Identical Payload Frames | ${identicalCount} |`);
  if (varyingLengthCount > 0) lines.push(`| Variable Length Frames | ${varyingLengthCount} |`);
  if (muxCount > 0) lines.push(`| Multiplexed Frames | ${muxCount} |`);
  if (burstCount > 0) lines.push(`| Burst Pattern Frames | ${burstCount} |`);
  lines.push("");

  // Mirror Groups
  if (results.mirrorGroups && results.mirrorGroups.length > 0) {
    lines.push("## Mirror Frame Groups");
    lines.push("");
    lines.push("Mirror frames are different CAN IDs that transmit identical payloads changing in unison.");
    lines.push("This often indicates redundant/backup signals or re-transmitted data.");
    lines.push("");

    for (let i = 0; i < results.mirrorGroups.length; i++) {
      const group = results.mirrorGroups[i];
      lines.push(`### Group ${i + 1}`);
      lines.push("");
      lines.push(`- **Frame IDs**: ${group.frameIds.map(id => formatFrameId(id)).join(", ")}`);
      lines.push(`- **Match Rate**: ${group.matchPercentage}%`);
      lines.push(`- **Matching Pairs**: ${group.sampleCount}`);
      if (group.samplePayload) {
        const hex = group.samplePayload.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        lines.push(`- **Sample Payload**: \`${hex}\``);
      }
      lines.push("");
    }
  }

  // Frame Details
  lines.push("## Frame Analysis Details");
  lines.push("");

  const sortedResults = [...results.analysisResults].sort((a, b) => a.frameId - b.frameId);

  for (const result of sortedResults) {
    lines.push(`### Frame ${formatFrameId(result.frameId)}`);
    lines.push("");

    // Metadata table
    lines.push("| Property | Value |");
    lines.push("|----------|-------|");
    lines.push(`| Samples | ${result.sampleCount} |`);
    lines.push(`| Identical | ${result.isIdentical ? 'Yes' : 'No'} |`);
    if (result.hasVaryingLength && result.lengthRange) {
      lines.push(`| Length Range | ${result.lengthRange.min}-${result.lengthRange.max} bytes |`);
    }
    lines.push(`| Multiplexed | ${result.isMuxFrame ? 'Yes' : 'No'} |`);
    lines.push(`| Burst Pattern | ${result.isBurstFrame ? 'Yes' : 'No'} |`);
    lines.push("");

    // Byte roles
    if (result.byteStats.length > 0) {
      lines.push("**Byte Roles:**");
      lines.push("");
      lines.push("| Byte | Role | Details |");
      lines.push("|------|------|---------|");

      for (const stat of result.byteStats) {
        let details = "";
        if (stat.role === 'static' && stat.staticValue !== undefined) {
          details = `Value: 0x${stat.staticValue.toString(16).toUpperCase().padStart(2, '0')}`;
        } else if (stat.role === 'counter') {
          if (stat.isLoopingCounter && stat.loopingRange && stat.loopingModulo) {
            details = `Looping ${stat.loopingRange.min}–${stat.loopingRange.max} (mod ${stat.loopingModulo}), step=${stat.counterStep}`;
          } else {
            details = stat.counterStep ? `Step: ${stat.counterStep}` : "";
          }
        } else if (stat.role === 'sensor' && stat.sensorTrend) {
          details = `Trend: ${stat.sensorTrend}`;
        } else if (stat.role === 'value') {
          details = `${stat.uniqueValues.size} unique values`;
        }
        lines.push(`| ${stat.byteIndex} | ${stat.role} | ${details} |`);
      }
      lines.push("");
    }

    // Multi-byte patterns
    if (result.multiBytePatterns && result.multiBytePatterns.length > 0) {
      lines.push("**Multi-Byte Patterns:**");
      lines.push("");
      for (const pattern of result.multiBytePatterns) {
        const range = `byte[${pattern.startByte}:${pattern.startByte + pattern.length - 1}]`;
        let desc = `\`${pattern.pattern}\``;
        if (pattern.endianness) desc += ` (${pattern.endianness} endian)`;
        if (pattern.rolloverDetected) desc += " - rollover detected";
        if (pattern.minValue !== undefined && pattern.maxValue !== undefined) {
          desc += ` - range: ${pattern.minValue} to ${pattern.maxValue}`;
        }
        if (pattern.sampleText) desc += ` - text: "${pattern.sampleText}"`;
        lines.push(`- **${range}**: ${desc}`);
      }
      lines.push("");
    }

    // Mux info
    if (result.isMuxFrame && result.muxInfo) {
      lines.push("**Multiplexing:**");
      lines.push("");
      lines.push(`- Selector: byte[${result.muxInfo.selectorByte}]`);
      lines.push(`- Values: ${result.muxInfo.selectorValues.map(v => `0x${v.toString(16).toUpperCase()}`).join(", ")}`);
      if (result.muxInfo.isTwoByte) lines.push("- Type: 2-byte selector");
      lines.push("");

      if (result.muxCaseAnalyses && result.muxCaseAnalyses.length > 0) {
        lines.push("**Per-Case Analysis:**");
        lines.push("");
        for (const muxCase of result.muxCaseAnalyses) {
          lines.push(`#### Case 0x${muxCase.muxValue.toString(16).toUpperCase()} (${muxCase.sampleCount} samples)`);
          lines.push("");
          if (muxCase.multiBytePatterns && muxCase.multiBytePatterns.length > 0) {
            for (const pattern of muxCase.multiBytePatterns) {
              const range = `byte[${pattern.startByte}:${pattern.startByte + pattern.length - 1}]`;
              lines.push(`- ${range}: ${pattern.pattern}` + (pattern.endianness ? ` (${pattern.endianness})` : ""));
            }
          }
          if (muxCase.notes && muxCase.notes.length > 0) {
            for (const note of muxCase.notes) {
              lines.push(`- ${note}`);
            }
          }
          lines.push("");
        }
      }
    }

    // Notes
    if (result.notes.length > 0) {
      lines.push("**Analysis Notes:**");
      lines.push("");
      for (const note of result.notes) {
        lines.push(`- ${note}`);
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("*Generated by WireTAP*");

  return lines.join("\n");
}

// ============================================================================
// HTML Report Generation (Screen Optimized)
// ============================================================================

function generateHtmlReport(results: ChangesResult): string {
  const identicalCount = results.analysisResults.filter(r => r.isIdentical).length;
  const varyingLengthCount = results.analysisResults.filter(r => r.hasVaryingLength).length;
  const muxCount = results.analysisResults.filter(r => r.isMuxFrame).length;
  const burstCount = results.analysisResults.filter(r => r.isBurstFrame).length;
  const mirrorCount = results.mirrorGroups?.length ?? 0;

  const sortedResults = [...results.analysisResults].sort((a, b) => a.frameId - b.frameId);

  // Additional styles specific to payload changes report
  const additionalStyles = `
    .badge-mirror { background: rgba(236, 72, 153, 0.2); color: #f472b6; }
    .badge-identical { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }
    .badge-varying { background: rgba(234, 179, 8, 0.2); color: #facc15; }
    .badge-mux { background: rgba(249, 115, 22, 0.2); color: #fb923c; }
    .badge-burst { background: rgba(34, 211, 238, 0.2); color: #22d3ee; }
    .frame-card {
      background: var(--bg-secondary);
      border-radius: 8px;
      padding: 1rem;
      margin: 1rem 0;
      border: 1px solid var(--border);
    }
    .frame-header {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 1rem;
    }
    .samples { font-size: 0.875rem; color: var(--text-secondary); }
    .byte-viz {
      font-family: monospace;
      padding: 0.5rem;
      background: var(--bg-card);
      border-radius: 4px;
      margin: 0.5rem 0;
    }
    .byte-viz .legend { font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.25rem; }
    .role-static { color: #94a3b8; }
    .role-counter { color: #22c55e; }
    .role-sensor { color: #3b82f6; }
    .role-value { color: #f59e0b; }
    .notes-list { margin: 0.5rem 0; padding-left: 1.5rem; }
    .notes-list li { margin: 0.25rem 0; color: var(--text-secondary); }
    .mirror-card {
      background: rgba(236, 72, 153, 0.1);
      border: 1px solid rgba(236, 72, 153, 0.3);
      border-radius: 8px;
      padding: 1rem;
      margin: 0.5rem 0;
    }
    .mirror-ids { font-family: monospace; font-weight: bold; color: #f472b6; }
`;

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CAN Payload Analysis Report</title>
  <style>
${DARK_THEME_STYLES}
${additionalStyles}
  </style>
</head>
<body>
  <div class="container">
    <h1>CAN Payload Analysis Report</h1>

    <div class="summary-grid">
      <div class="summary-card">
        <div class="value">${results.frameCount.toLocaleString()}</div>
        <div class="label">Total Frames</div>
      </div>
      <div class="summary-card">
        <div class="value">${results.uniqueFrameIds}</div>
        <div class="label">Unique IDs</div>
      </div>
      ${mirrorCount > 0 ? `<div class="summary-card"><div class="value">${mirrorCount}</div><div class="label">Mirror Groups</div></div>` : ''}
      ${muxCount > 0 ? `<div class="summary-card"><div class="value">${muxCount}</div><div class="label">Multiplexed</div></div>` : ''}
    </div>

    <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0;">
      ${mirrorCount > 0 ? '<span class="badge badge-mirror">Mirror Groups</span>' : ''}
      ${identicalCount > 0 ? '<span class="badge badge-identical">Identical</span>' : ''}
      ${varyingLengthCount > 0 ? '<span class="badge badge-varying">Varying Length</span>' : ''}
      ${muxCount > 0 ? '<span class="badge badge-mux">Multiplexed</span>' : ''}
      ${burstCount > 0 ? '<span class="badge badge-burst">Burst</span>' : ''}
    </div>
`;

  // Mirror Groups
  if (results.mirrorGroups && results.mirrorGroups.length > 0) {
    html += `
    <h2>Mirror Frame Groups</h2>
    <p style="color: var(--text-secondary); margin-bottom: 1rem;">
      These frame IDs transmit identical payloads that change together.
    </p>
`;
    for (const group of results.mirrorGroups) {
      const ids = group.frameIds.map(id => formatFrameId(id)).join(' ↔ ');
      const hex = group.samplePayload?.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') || '';
      html += `
    <div class="mirror-card">
      <div class="mirror-ids">${ids}</div>
      <div style="font-size: 0.875rem; color: var(--text-secondary); margin-top: 0.5rem;">
        Match rate: ${group.matchPercentage}% (${group.sampleCount} pairs)
        ${hex ? `<br>Sample: <code>${hex}</code>` : ''}
      </div>
    </div>
`;
    }
  }

  // Frame Analysis
  html += `
    <h2>Frame Analysis</h2>
`;

  for (const result of sortedResults) {
    const flags: string[] = [];
    if (result.isIdentical) flags.push('<span class="badge badge-identical">Identical</span>');
    if (result.hasVaryingLength && result.lengthRange) {
      flags.push(`<span class="badge badge-varying">${result.lengthRange.min}-${result.lengthRange.max} bytes</span>`);
    }
    if (result.isMuxFrame) flags.push('<span class="badge badge-mux">Mux</span>');
    if (result.isBurstFrame) flags.push('<span class="badge badge-burst">Burst</span>');

    html += `
    <div class="frame-card">
      <div class="frame-header">
        <span class="frame-id">${formatFrameId(result.frameId)}</span>
        <span class="samples">${result.sampleCount} samples</span>
        ${flags.join('')}
      </div>
`;

    // Byte visualization
    if (result.byteStats.length > 0) {
      const byteRow = result.byteStats.map(s => {
        const cls = s.role === 'static' ? 'role-static' : s.role === 'counter' ? 'role-counter' : s.role === 'sensor' ? 'role-sensor' : 'role-value';
        const char = s.role === 'static' ? '█' : s.role === 'counter' ? '▲' : s.role === 'sensor' ? '≈' : '?';
        return `<span class="${cls}">${char}</span>`;
      }).join('');
      html += `
      <div class="byte-viz">
        [${byteRow}]
        <div class="legend">
          <span class="role-static">█ static</span> &nbsp;
          <span class="role-counter">▲ counter</span> &nbsp;
          <span class="role-sensor">≈ sensor</span> &nbsp;
          <span class="role-value">? value</span>
        </div>
      </div>
`;
    }

    // Multi-byte patterns
    if (result.multiBytePatterns && result.multiBytePatterns.length > 0) {
      html += `
      <h3>Detected Patterns</h3>
      <table>
        <tr><th>Range</th><th>Pattern</th><th>Details</th></tr>
`;
      for (const pattern of result.multiBytePatterns) {
        const range = `byte[${pattern.startByte}:${pattern.startByte + pattern.length - 1}]`;
        let details = '';
        if (pattern.endianness) details += pattern.endianness + ' endian';
        if (pattern.rolloverDetected) details += (details ? ', ' : '') + 'rollover';
        if (pattern.sampleText) details += (details ? ', ' : '') + `"${pattern.sampleText}"`;
        html += `        <tr><td><code>${range}</code></td><td>${pattern.pattern}</td><td>${details}</td></tr>\n`;
      }
      html += `      </table>\n`;
    }

    // Notes
    if (result.notes.length > 0) {
      html += `
      <h3>Notes</h3>
      <ul class="notes-list">
        ${result.notes.map(n => `<li>${n}</li>`).join('\n        ')}
      </ul>
`;
    }

    html += `    </div>\n`;
  }

  html += `
    <div class="footer">
      Generated by WireTAP
    </div>
  </div>
</body>
</html>`;

  return html;
}

// ============================================================================
// PDF-Ready Report Generation (Print Optimized)
// ============================================================================

function generatePdfReadyReport(results: ChangesResult): string {
  const identicalCount = results.analysisResults.filter(r => r.isIdentical).length;
  const varyingLengthCount = results.analysisResults.filter(r => r.hasVaryingLength).length;
  const muxCount = results.analysisResults.filter(r => r.isMuxFrame).length;
  const burstCount = results.analysisResults.filter(r => r.isBurstFrame).length;
  const mirrorCount = results.mirrorGroups?.length ?? 0;

  const sortedResults = [...results.analysisResults].sort((a, b) => a.frameId - b.frameId);

  // Additional print-specific styles
  const additionalStyles = `
    .badge-mirror { background: #fce7f3; color: #be185d; }
    .badge-identical { background: #f1f5f9; color: #475569; }
    .badge-varying { background: #fef3c7; color: #92400e; }
    .badge-mux { background: #ffedd5; color: #c2410c; }
    .badge-burst { background: #cffafe; color: #0e7490; }
    .badge-row {
      display: flex;
      gap: 6pt;
      flex-wrap: wrap;
      margin: 8pt 0;
    }
    .frame-card {
      border: 1pt solid var(--border);
      border-radius: 4pt;
      padding: 10pt;
      margin: 8pt 0;
      background: white;
    }
    .frame-header {
      display: flex;
      align-items: center;
      gap: 8pt;
      flex-wrap: wrap;
      margin-bottom: 8pt;
    }
    .samples {
      font-size: 9pt;
      color: var(--text-muted);
    }
    .byte-viz {
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 9pt;
      padding: 6pt;
      background: var(--bg-light);
      border-radius: 3pt;
      margin: 4pt 0;
    }
    .legend {
      font-size: 7pt;
      color: var(--text-muted);
      margin-top: 2pt;
    }
    .role-static { color: #64748b; }
    .role-counter { color: #16a34a; }
    .role-sensor { color: #7c3aed; }
    .role-value { color: #f59e0b; }
    .notes-list {
      margin: 4pt 0;
      padding-left: 16pt;
      font-size: 9pt;
    }
    .notes-list li {
      margin: 2pt 0;
      color: var(--text-secondary);
    }
    .mirror-card {
      background: #fdf2f8;
      border: 1pt solid #fbcfe8;
      border-radius: 4pt;
      padding: 8pt;
      margin: 6pt 0;
    }
    .mirror-ids {
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-weight: 700;
      color: #be185d;
    }
`;

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CAN Payload Analysis Report</title>
  <style>
${PRINT_THEME_STYLES}
${additionalStyles}
  </style>
</head>
<body>
  <h1>CAN Payload Analysis Report</h1>

  <div class="print-instructions">
    <strong>To save as PDF:</strong> Use your browser's Print function (Ctrl+P / Cmd+P) and select "Save as PDF" as the destination.
  </div>

  <div class="summary-box">
    <div class="summary-grid">
      <div class="stat-item">
        <div class="value">${results.frameCount.toLocaleString()}</div>
        <div class="label">Total Frames</div>
      </div>
      <div class="stat-item">
        <div class="value">${results.uniqueFrameIds}</div>
        <div class="label">Unique IDs</div>
      </div>
      ${mirrorCount > 0 ? `<div class="stat-item"><div class="value">${mirrorCount}</div><div class="label">Mirror Groups</div></div>` : ''}
      ${muxCount > 0 ? `<div class="stat-item"><div class="value">${muxCount}</div><div class="label">Multiplexed</div></div>` : ''}
    </div>

    <div class="badge-row">
      ${mirrorCount > 0 ? '<span class="badge badge-mirror">Mirror Groups</span>' : ''}
      ${identicalCount > 0 ? '<span class="badge badge-identical">Identical</span>' : ''}
      ${varyingLengthCount > 0 ? '<span class="badge badge-varying">Varying Length</span>' : ''}
      ${muxCount > 0 ? '<span class="badge badge-mux">Multiplexed</span>' : ''}
      ${burstCount > 0 ? '<span class="badge badge-burst">Burst</span>' : ''}
    </div>
  </div>
`;

  // Mirror Groups
  if (results.mirrorGroups && results.mirrorGroups.length > 0) {
    html += `
  <h2>Mirror Frame Groups</h2>
  <p style="font-size: 9pt; color: var(--text-secondary); margin-bottom: 8pt;">
    These frame IDs transmit identical payloads that change together.
  </p>
`;
    for (const group of results.mirrorGroups) {
      const ids = group.frameIds.map(id => formatFrameId(id)).join(' ↔ ');
      const hex = group.samplePayload?.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') || '';
      html += `
  <div class="mirror-card no-break">
    <div class="mirror-ids">${ids}</div>
    <div style="font-size: 8pt; color: #9d174d; margin-top: 4pt;">
      Match rate: ${group.matchPercentage}% (${group.sampleCount} pairs)
      ${hex ? `&nbsp;|&nbsp; Sample: <code>${hex}</code>` : ''}
    </div>
  </div>
`;
    }
  }

  // Frame Analysis
  html += `
  <h2>Frame Analysis</h2>
`;

  for (const result of sortedResults) {
    const flags: string[] = [];
    if (result.isIdentical) flags.push('<span class="badge badge-identical">Identical</span>');
    if (result.hasVaryingLength && result.lengthRange) {
      flags.push(`<span class="badge badge-varying">${result.lengthRange.min}-${result.lengthRange.max} bytes</span>`);
    }
    if (result.isMuxFrame) flags.push('<span class="badge badge-mux">Mux</span>');
    if (result.isBurstFrame) flags.push('<span class="badge badge-burst">Burst</span>');

    html += `
  <div class="frame-card no-break">
    <div class="frame-header">
      <span class="frame-id">${formatFrameId(result.frameId)}</span>
      <span class="samples">${result.sampleCount} samples</span>
      ${flags.join('')}
    </div>
`;

    // Byte visualization
    if (result.byteStats.length > 0) {
      const byteRow = result.byteStats.map(s => {
        const cls = s.role === 'static' ? 'role-static' : s.role === 'counter' ? 'role-counter' : s.role === 'sensor' ? 'role-sensor' : 'role-value';
        const char = s.role === 'static' ? '█' : s.role === 'counter' ? '▲' : s.role === 'sensor' ? '≈' : '?';
        return `<span class="${cls}">${char}</span>`;
      }).join('');
      html += `
    <div class="byte-viz">
      [${byteRow}]
      <div class="legend">
        <span class="role-static">█ static</span> &nbsp;
        <span class="role-counter">▲ counter</span> &nbsp;
        <span class="role-sensor">≈ sensor</span> &nbsp;
        <span class="role-value">? value</span>
      </div>
    </div>
`;
    }

    // Multi-byte patterns
    if (result.multiBytePatterns && result.multiBytePatterns.length > 0) {
      html += `
    <h3>Detected Patterns</h3>
    <table>
      <tr><th>Range</th><th>Pattern</th><th>Details</th></tr>
`;
      for (const pattern of result.multiBytePatterns) {
        const range = `byte[${pattern.startByte}:${pattern.startByte + pattern.length - 1}]`;
        let details = '';
        if (pattern.endianness) details += pattern.endianness + ' endian';
        if (pattern.rolloverDetected) details += (details ? ', ' : '') + 'rollover';
        if (pattern.sampleText) details += (details ? ', ' : '') + `"${pattern.sampleText}"`;
        html += `      <tr><td><code>${range}</code></td><td>${pattern.pattern}</td><td>${details}</td></tr>\n`;
      }
      html += `    </table>\n`;
    }

    // Notes
    if (result.notes.length > 0) {
      html += `
    <h3>Notes</h3>
    <ul class="notes-list">
      ${result.notes.map(n => `<li>${n}</li>`).join('\n      ')}
    </ul>
`;
    }

    html += `  </div>\n`;
  }

  html += `
  <div class="footer">
    Generated by WireTAP
  </div>
</body>
</html>`;

  return html;
}

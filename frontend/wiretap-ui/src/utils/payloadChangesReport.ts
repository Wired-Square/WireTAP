// ui/src/utils/payloadChangesReport.ts
// Report generation for Payload Changes analysis

import i18n from "i18next";
import type { ChangesResult } from "../stores/discoveryStore";
import type { ByteColumn, ChangesFrame, MultiBytePattern } from "../api/byteRoles";
import { type ExportFormat, DARK_THEME_STYLES, PRINT_THEME_STYLES } from "./reportExport";
import { formatFrameKey } from "./frameIds";
import { caseNoteLines, frameNoteLines } from "./analysis/byteNoteText";

const byteRange = (p: MultiBytePattern) => `byte[${p.start}:${p.start + p.len - 1}]`;

const hexPayload = (bytes: number[]) => bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

const caseLabel = (value: number) => `0x${value.toString(16).toUpperCase()}`;

/** One frame as the report prints it, its notes worded. */
type Row = {
  frame: ChangesFrame;
  id: string;
  varyingLength: boolean;
  notes: string[];
  cases: { value: number; sampleCount: number; patterns: MultiBytePattern[]; notes: string[] }[];
};

function rows(results: ChangesResult): Row[] {
  const t = i18n.t.bind(i18n);
  return [...results.frames]
    .sort((a, b) => a.frameId - b.frameId)
    .map((frame) => {
      const selector = frame.mux?.detection.selector;
      return {
        frame,
        id: formatFrameKey(frame.protocol ?? "can", frame),
        varyingLength: frame.minLen !== frame.maxLen,
        notes: frameNoteLines(t, frame.notes.frame, selector),
        cases: (frame.mux?.cases ?? []).map((c) => ({
          value: c.value,
          sampleCount: c.sampleCount,
          patterns: c.patterns,
          notes: caseNoteLines(t, frame.notes.cases.find((n) => n.value === c.value)?.notes ?? [], selector!),
        })),
      };
    });
}

/** Each mirror group with its ids formatted under its protocol. */
function mirrors(results: ChangesResult) {
  return results.mirrors.flatMap(({ protocol, groups }) =>
    groups.map((group) => ({ ...group, ids: group.keys.map((k) => formatFrameKey(protocol, k)) }))
  );
}

function summary(results: ChangesResult, all: Row[]) {
  return {
    identicalCount: all.filter(r => r.frame.identical !== null).length,
    varyingLengthCount: all.filter(r => r.varyingLength).length,
    muxCount: all.filter(r => r.frame.mux !== null).length,
    burstCount: all.filter(r => r.frame.burst).length,
    mirrorCount: mirrors(results).length,
  };
}

/**
 * Each pattern with the label it prints under. A mux frame's come from its cases:
 * its top-level ones span every case, so printing both would print them twice.
 */
function labelledPatterns(row: Row): { label: string; pattern: MultiBytePattern }[] {
  if (!row.frame.mux) {
    return row.frame.patterns.map((pattern) => ({ label: byteRange(pattern), pattern }));
  }
  return row.cases.flatMap((c) =>
    c.patterns.map((pattern) => ({ label: `case ${caseLabel(c.value)} ${byteRange(pattern)}`, pattern }))
  );
}

/** Each role's text mark, and its glyph and class in the HTML byte row. */
const ROLE_MARKS: Record<ByteColumn['role'], { mark: string; glyph: string; cls: string }> = {
  static: { mark: '#', glyph: '█', cls: 'role-static' },
  counter: { mark: '^', glyph: '▲', cls: 'role-counter' },
  sensor: { mark: '~', glyph: '≈', cls: 'role-sensor' },
  value: { mark: '?', glyph: '?', cls: 'role-value' },
  unknown: { mark: ' ', glyph: '?', cls: 'role-value' },
};

function patternDetails(pattern: MultiBytePattern): string {
  const details: string[] = [];
  if (pattern.endianness) details.push(`${pattern.endianness} endian`);
  if (pattern.rollover) details.push('rollover');
  if (pattern.sampleText) details.push(`"${pattern.sampleText}"`);
  return details.join(', ');
}

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
  const all = rows(results);
  const counts = summary(results, all);

  lines.push(divider);
  lines.push("  CAN PAYLOAD ANALYSIS REPORT");
  lines.push(divider);
  lines.push("");

  lines.push("SUMMARY");
  lines.push(thinDivider);
  lines.push(`  Total Frames Analysed: ${results.frameCount.toLocaleString()}`);
  lines.push(`  Unique Frame IDs:      ${all.length}`);
  lines.push("");

  if (counts.mirrorCount > 0) lines.push(`  Mirror Groups:       ${counts.mirrorCount}`);
  if (counts.identicalCount > 0) lines.push(`  Identical Frames:    ${counts.identicalCount}`);
  if (counts.varyingLengthCount > 0) lines.push(`  Varying Length:      ${counts.varyingLengthCount}`);
  if (counts.muxCount > 0) lines.push(`  Multiplexed:         ${counts.muxCount}`);
  if (counts.burstCount > 0) lines.push(`  Burst Frames:        ${counts.burstCount}`);
  lines.push("");

  const groups = mirrors(results);
  if (groups.length > 0) {
    lines.push("MIRROR FRAMES");
    lines.push(thinDivider);
    lines.push("  These frame IDs transmit identical payloads that change together:");
    lines.push("");
    for (const group of groups) {
      lines.push(`  ${group.ids.join(" <-> ")}`);
      lines.push(`    Match rate: ${group.matchPercentage}% (${group.sampleCount} paired samples)`);
      lines.push(`    Sample:     ${hexPayload(group.samplePayload)}`);
      lines.push("");
    }
  }

  lines.push("FRAME ANALYSIS");
  lines.push(divider);

  for (const row of all) {
    const { frame } = row;
    lines.push("");
    lines.push(`+-- Frame ${row.id} ` + "-".repeat(50));
    lines.push(`|  Samples: ${frame.sampleCount}`);

    const flags: string[] = [];
    if (frame.identical) flags.push("Identical");
    if (row.varyingLength) flags.push(`Length ${frame.minLen}-${frame.maxLen}`);
    if (frame.mux) flags.push("Multiplexed");
    if (frame.burst) flags.push("Burst");
    if (flags.length > 0) {
      lines.push(`|  Flags:   ${flags.join(", ")}`);
    }

    if (frame.columns.length > 0) {
      lines.push("|");
      lines.push("|  Byte Analysis:");
      lines.push(`|  [${frame.columns.map(c => ROLE_MARKS[c.role].mark).join('')}]`);
      lines.push(`|   #=static  ^=counter  ~=sensor  ?=value`);
    }

    // A mux frame's patterns print in its cases' notes
    if (!frame.mux && frame.patterns.length > 0) {
      lines.push("|");
      lines.push("|  Detected Patterns:");
      for (const pattern of frame.patterns) {
        let desc: string = pattern.kind;
        if (pattern.endianness) desc += ` (${pattern.endianness})`;
        if (pattern.rollover) desc += " +rollover";
        if (pattern.sampleText) desc += ` "${pattern.sampleText}"`;
        lines.push(`|    ${byteRange(pattern)}: ${desc}`);
      }
    }

    if (row.notes.length > 0) {
      lines.push("|");
      lines.push("|  Notes:");
      for (const note of row.notes) {
        lines.push(`|    - ${note}`);
      }
    }

    if (row.cases.length > 0) {
      lines.push("|");
      lines.push("|  Mux Cases:");
      for (const muxCase of row.cases) {
        lines.push(`|    Case ${caseLabel(muxCase.value)}: ${muxCase.sampleCount} samples`);
        for (const note of muxCase.notes) {
          lines.push(`|      ${note}`);
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

function roleDetails(c: ByteColumn): string {
  switch (c.role) {
    case 'static':
      return `Value: 0x${c.value.toString(16).toUpperCase().padStart(2, '0')}`;
    case 'counter':
      return c.looping
        ? `Looping ${c.looping.min}–${c.looping.max} (mod ${c.looping.modulo}), step=${c.step}`
        : `Step: ${c.step}`;
    case 'sensor':
      return `Trend: ${c.trend}`;
    case 'value':
      return `${c.distinctValues} unique values`;
    default:
      return "";
  }
}

function generateMarkdownReport(results: ChangesResult): string {
  const lines: string[] = [];
  const all = rows(results);
  const counts = summary(results, all);

  lines.push("# CAN Bus Payload Analysis Report");
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total Frames | ${results.frameCount.toLocaleString()} |`);
  lines.push(`| Unique Frame IDs | ${all.length} |`);
  if (counts.mirrorCount > 0) lines.push(`| Mirror Groups | ${counts.mirrorCount} |`);
  if (counts.identicalCount > 0) lines.push(`| Identical Payload Frames | ${counts.identicalCount} |`);
  if (counts.varyingLengthCount > 0) lines.push(`| Variable Length Frames | ${counts.varyingLengthCount} |`);
  if (counts.muxCount > 0) lines.push(`| Multiplexed Frames | ${counts.muxCount} |`);
  if (counts.burstCount > 0) lines.push(`| Burst Pattern Frames | ${counts.burstCount} |`);
  lines.push("");

  const groups = mirrors(results);
  if (groups.length > 0) {
    lines.push("## Mirror Frame Groups");
    lines.push("");
    lines.push("Mirror frames are different CAN IDs that transmit identical payloads changing in unison.");
    lines.push("This often indicates redundant/backup signals or re-transmitted data.");
    lines.push("");
    groups.forEach((group, i) => {
      lines.push(`### Group ${i + 1}`);
      lines.push("");
      lines.push(`- **Frame IDs**: ${group.ids.join(", ")}`);
      lines.push(`- **Match Rate**: ${group.matchPercentage}%`);
      lines.push(`- **Paired Samples**: ${group.sampleCount}`);
      lines.push(`- **Sample Payload**: \`${hexPayload(group.samplePayload)}\``);
      lines.push("");
    });
  }

  lines.push("## Frame Analysis Details");
  lines.push("");

  for (const row of all) {
    const { frame } = row;
    lines.push(`### Frame ${row.id}`);
    lines.push("");
    lines.push("| Property | Value |");
    lines.push("|----------|-------|");
    lines.push(`| Samples | ${frame.sampleCount} |`);
    lines.push(`| Identical | ${frame.identical ? 'Yes' : 'No'} |`);
    if (row.varyingLength) {
      lines.push(`| Length Range | ${frame.minLen}-${frame.maxLen} bytes |`);
    }
    lines.push(`| Multiplexed | ${frame.mux ? 'Yes' : 'No'} |`);
    lines.push(`| Burst Pattern | ${frame.burst ? 'Yes' : 'No'} |`);
    lines.push("");

    if (frame.columns.length > 0) {
      lines.push("**Byte Roles:**");
      lines.push("");
      lines.push("| Byte | Role | Details |");
      lines.push("|------|------|---------|");
      for (const c of frame.columns) {
        lines.push(`| ${c.position} | ${c.role} | ${roleDetails(c)} |`);
      }
      lines.push("");
    }

    // A mux frame's patterns are under Per-Case Analysis
    if (!frame.mux && frame.patterns.length > 0) {
      lines.push("**Multi-Byte Patterns:**");
      lines.push("");
      for (const pattern of frame.patterns) {
        let desc = `\`${pattern.kind}\``;
        if (pattern.endianness) desc += ` (${pattern.endianness} endian)`;
        if (pattern.rollover) desc += " - rollover detected";
        if (pattern.range) desc += ` - range: ${pattern.range[0]} to ${pattern.range[1]}`;
        if (pattern.sampleText) desc += ` - text: "${pattern.sampleText}"`;
        lines.push(`- **${byteRange(pattern)}**: ${desc}`);
      }
      lines.push("");
    }

    if (frame.mux) {
      lines.push("**Multiplexing:**");
      lines.push("");
      lines.push(`- Selector: ${frame.mux.detection.selector === 'twoByte' ? 'byte[0:1]' : 'byte[0]'}`);
      lines.push(`- Values: ${frame.mux.cases.map(c => caseLabel(c.value)).join(", ")}`);
      if (frame.mux.detection.selector === 'twoByte') lines.push("- Type: 2-byte selector");
      lines.push("");

      if (row.cases.length > 0) {
        lines.push("**Per-Case Analysis:**");
        lines.push("");
        for (const muxCase of row.cases) {
          lines.push(`#### Case ${caseLabel(muxCase.value)} (${muxCase.sampleCount} samples)`);
          lines.push("");
          for (const pattern of muxCase.patterns) {
            lines.push(`- ${byteRange(pattern)}: ${pattern.kind}` + (pattern.endianness ? ` (${pattern.endianness})` : ""));
          }
          for (const note of muxCase.notes) {
            lines.push(`- ${note}`);
          }
          lines.push("");
        }
      }
    }

    if (row.notes.length > 0) {
      lines.push("**Analysis Notes:**");
      lines.push("");
      for (const note of row.notes) {
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
// HTML Report Generation
// ============================================================================

type HtmlTheme = { themeStyles: string; additionalStyles: string; card: string; containerOpen: string; containerClose: string; preamble: string };

function frameFlags(row: Row): string {
  const flags: string[] = [];
  if (row.frame.identical) flags.push('<span class="badge badge-identical">Identical</span>');
  if (row.varyingLength) flags.push(`<span class="badge badge-varying">${row.frame.minLen}-${row.frame.maxLen} bytes</span>`);
  if (row.frame.mux) flags.push('<span class="badge badge-mux">Mux</span>');
  if (row.frame.burst) flags.push('<span class="badge badge-burst">Burst</span>');
  return flags.join('');
}

function frameHtml(row: Row, card: string): string {
  const { frame } = row;
  let html = `
    <div class="${card}">
      <div class="frame-header">
        <span class="frame-id">${row.id}</span>
        <span class="samples">${frame.sampleCount} samples</span>
        ${frameFlags(row)}
      </div>
`;

  if (frame.columns.length > 0) {
    const byteRow = frame.columns.map(c => `<span class="${ROLE_MARKS[c.role].cls}">${ROLE_MARKS[c.role].glyph}</span>`).join('');
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

  const patterns = labelledPatterns(row);
  if (patterns.length > 0) {
    html += `
      <h3>Detected Patterns</h3>
      <table>
        <tr><th>Range</th><th>Pattern</th><th>Details</th></tr>
${patterns.map(({ label, pattern }) => `        <tr><td><code>${label}</code></td><td>${pattern.kind}</td><td>${patternDetails(pattern)}</td></tr>`).join('\n')}
      </table>
`;
  }

  if (row.notes.length > 0) {
    html += `
      <h3>Notes</h3>
      <ul class="notes-list">
        ${row.notes.map(n => `<li>${n}</li>`).join('\n        ')}
      </ul>
`;
  }

  return html + `    </div>\n`;
}

function htmlReport(results: ChangesResult, theme: HtmlTheme): string {
  const all = rows(results);
  const counts = summary(results, all);
  const groups = mirrors(results);

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CAN Payload Analysis Report</title>
  <style>
${theme.themeStyles}
${theme.additionalStyles}
  </style>
</head>
<body>
  ${theme.containerOpen}
    <h1>CAN Payload Analysis Report</h1>
    ${theme.preamble}
    <div class="summary-grid">
      <div class="summary-card stat-item"><div class="value">${results.frameCount.toLocaleString()}</div><div class="label">Total Frames</div></div>
      <div class="summary-card stat-item"><div class="value">${all.length}</div><div class="label">Unique IDs</div></div>
      ${counts.mirrorCount > 0 ? `<div class="summary-card stat-item"><div class="value">${counts.mirrorCount}</div><div class="label">Mirror Groups</div></div>` : ''}
      ${counts.muxCount > 0 ? `<div class="summary-card stat-item"><div class="value">${counts.muxCount}</div><div class="label">Multiplexed</div></div>` : ''}
    </div>

    <div class="badge-row" style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0;">
      ${counts.mirrorCount > 0 ? '<span class="badge badge-mirror">Mirror Groups</span>' : ''}
      ${counts.identicalCount > 0 ? '<span class="badge badge-identical">Identical</span>' : ''}
      ${counts.varyingLengthCount > 0 ? '<span class="badge badge-varying">Varying Length</span>' : ''}
      ${counts.muxCount > 0 ? '<span class="badge badge-mux">Multiplexed</span>' : ''}
      ${counts.burstCount > 0 ? '<span class="badge badge-burst">Burst</span>' : ''}
    </div>
`;

  if (groups.length > 0) {
    html += `
    <h2>Mirror Frame Groups</h2>
    <p>These frame IDs transmit identical payloads that change together.</p>
`;
    for (const group of groups) {
      html += `
    <div class="mirror-card no-break">
      <div class="mirror-ids">${group.ids.join(' ↔ ')}</div>
      <div>Match rate: ${group.matchPercentage}% (${group.sampleCount} paired samples) · Sample: <code>${hexPayload(group.samplePayload)}</code></div>
    </div>
`;
    }
  }

  html += `
    <h2>Frame Analysis</h2>
${all.map((row) => frameHtml(row, theme.card)).join('')}
    <div class="footer">
      Generated by WireTAP
    </div>
  ${theme.containerClose}
</body>
</html>`;

  return html;
}

function generateHtmlReport(results: ChangesResult): string {
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

  return htmlReport(results, {
    themeStyles: DARK_THEME_STYLES,
    additionalStyles,
    card: 'frame-card',
    containerOpen: '<div class="container">',
    containerClose: '</div>',
    preamble: '',
  });
}

function generatePdfReadyReport(results: ChangesResult): string {
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

  return htmlReport(results, {
    themeStyles: PRINT_THEME_STYLES,
    additionalStyles,
    card: 'frame-card no-break',
    containerOpen: '',
    containerClose: '',
    preamble: `<div class="print-instructions">
    <strong>To save as PDF:</strong> Use your browser's Print function (Ctrl+P / Cmd+P) and select "Save as PDF" as the destination.
  </div>`,
  });
}

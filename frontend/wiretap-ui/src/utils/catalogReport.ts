// ui/src/utils/catalogReport.ts
// Report generation for CAN Catalog documentation

import type { CatalogDoc, IdBodyDoc, SignalDoc, MuxDoc, MuxCaseDoc, Confidence } from "../types/catalog";
import {
  CATALOG_SCREEN_THEME,
  CATALOG_PRINT_THEME,
  type CatalogTheme,
} from "./reportExport";
import { formatFrameId } from "./frameIds";
import { sortMuxCaseKeys, isMuxCaseKey } from "./muxCaseMatch";

export type CatalogReportFormat = "text" | "markdown" | "html-screen" | "html-print";

/**
 * Parse catalog TOML content and generate a report in the specified format
 */
export function generateCatalogReport(catalogDoc: CatalogDoc, format: CatalogReportFormat): string {
  switch (format) {
    case "text":
      return generateTextReport(catalogDoc);
    case "markdown":
      return generateMarkdownReport(catalogDoc);
    case "html-screen":
      return generateHtmlReport(catalogDoc, CATALOG_SCREEN_THEME);
    case "html-print":
      return generateHtmlReport(catalogDoc, CATALOG_PRINT_THEME);
  }
}

// ============================================================================
// Helpers
// ============================================================================

interface FrameStats {
  frameCount: number;
  signalCount: number;
  muxFrameCount: number;
  enumSignalCount: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  noConfidence: number;
}

/**
 * Get the frames object from a catalog document.
 * Supports both old format ([id."0x123"]) and new format ([frame.can."0x123"]).
 */
function getFramesObject(catalogDoc: CatalogDoc): Record<string, IdBodyDoc> | undefined {
  // New format: frame.can
  const frameCanFrames = (catalogDoc as any).frame?.can;
  if (frameCanFrames && typeof frameCanFrames === "object") {
    return frameCanFrames;
  }
  // Old format: id
  if (catalogDoc.id) {
    return catalogDoc.id;
  }
  return undefined;
}

function getFrameStats(catalogDoc: CatalogDoc): FrameStats {
  let frameCount = 0;
  let signalCount = 0;
  let muxFrameCount = 0;
  let enumSignalCount = 0;
  let highConfidence = 0;
  let mediumConfidence = 0;
  let lowConfidence = 0;
  let noConfidence = 0;

  const frames = getFramesObject(catalogDoc);
  if (frames) {
    for (const [, frame] of Object.entries(frames)) {
      frameCount++;
      if (frame.mux) muxFrameCount++;
      const signals = collectAllSignals(frame);
      signalCount += signals.length;
      for (const sig of signals) {
        if (sig.enum && Object.keys(sig.enum).length > 0) enumSignalCount++;
        const conf = sig.confidence ?? "none";
        if (conf === "high") highConfidence++;
        else if (conf === "medium") mediumConfidence++;
        else if (conf === "low") lowConfidence++;
        else noConfidence++;
      }
    }
  }

  return { frameCount, signalCount, muxFrameCount, enumSignalCount, highConfidence, mediumConfidence, lowConfidence, noConfidence };
}

function collectAllSignals(frame: IdBodyDoc): SignalDoc[] {
  const signals: SignalDoc[] = [];
  if (frame.signals) {
    signals.push(...frame.signals);
  }
  if (frame.mux) {
    const muxes = Array.isArray(frame.mux) ? frame.mux : [frame.mux];
    for (const mux of muxes) {
      collectMuxSignals(mux, signals);
    }
  }
  return signals;
}

/**
 * Get mux cases from a MuxDoc.
 * TOML stores cases as numeric keys directly on the mux object (e.g., mux."1", mux."0-3")
 * rather than under a "case" property. Supports range keys like "0-3" and comma-separated "1,2,5".
 */
function getMuxCases(mux: MuxDoc): Array<[string, MuxCaseDoc]> {
  const cases: Array<[string, MuxCaseDoc]> = [];

  // Check for cases stored directly on mux object (TOML format: mux."1", mux."0-3", etc.)
  for (const [key, value] of Object.entries(mux)) {
    if (isMuxCaseKey(key) && typeof value === "object" && value !== null) {
      cases.push([key, value as MuxCaseDoc]);
    }
  }

  // Also check legacy "case" property
  if (mux.case) {
    for (const [key, value] of Object.entries(mux.case)) {
      cases.push([key, value]);
    }
  }

  // Sort using shared utility (handles ranges like "0-3" by sorting by first value)
  const sortedKeys = sortMuxCaseKeys(cases.map(([k]) => k));
  const caseMap = new Map(cases);
  return sortedKeys.map((k) => [k, caseMap.get(k)!]);
}

function collectMuxSignals(mux: MuxDoc, signals: SignalDoc[]): void {
  const cases = getMuxCases(mux);
  for (const [, muxCase] of cases) {
    if (muxCase.signals) {
      signals.push(...muxCase.signals);
    }
    if (muxCase.mux) {
      collectMuxSignals(muxCase.mux, signals);
    }
  }
}

function getConfidenceLabel(conf: Confidence | undefined): string {
  return conf ?? "none";
}

function formatScale(factor?: number, offset?: number): string {
  const f = factor ?? 1.0;
  const o = offset ?? 0.0;
  if (f === 1.0 && o === 0.0) return "-";
  return `x${f} + ${o}`;
}

function formatEndianness(endianness?: string, defaultEndianness?: string): string {
  const e = endianness ?? defaultEndianness ?? "little";
  return e === "little" ? "LE" : "BE";
}

function formatEnumValues(enumMap?: Record<number, string>): string {
  if (!enumMap) return "";
  const entries = Object.entries(enumMap);
  if (entries.length === 0) return "";
  // Show all enum values in compact form
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

function hasEnumSignals(signals: SignalDoc[]): boolean {
  return signals.some(sig => sig.enum && Object.keys(sig.enum).length > 0);
}

function formatNotes(notes?: string | string[]): string {
  if (!notes) return "";
  if (Array.isArray(notes)) return notes.join("; ");
  return notes;
}

function formatTransmitter(transmitter?: string | string[]): string {
  if (!transmitter) return "";
  if (Array.isArray(transmitter)) return transmitter.join(", ");
  return transmitter;
}

function getFrameInterval(frame: IdBodyDoc, defaultInterval?: number): { value: number | undefined; isDefault: boolean } {
  // Check direct tx_interval_ms first
  if (frame.tx_interval_ms !== undefined) {
    return { value: frame.tx_interval_ms, isDefault: false };
  }
  // Check nested tx.interval_ms
  if (frame.tx?.interval_ms !== undefined) {
    return { value: frame.tx.interval_ms, isDefault: false };
  }
  // Fall back to default interval
  if (defaultInterval !== undefined) {
    return { value: defaultInterval, isDefault: true };
  }
  return { value: undefined, isDefault: false };
}

function getSortedFrames(catalogDoc: CatalogDoc): Array<[number, string, IdBodyDoc]> {
  const framesObj = getFramesObject(catalogDoc);
  if (!framesObj) return [];

  const frames: Array<[number, string, IdBodyDoc]> = [];
  for (const [idStr, frame] of Object.entries(framesObj)) {
    const id = idStr.startsWith("0x") ? parseInt(idStr, 16) : parseInt(idStr, 10);
    frames.push([id, idStr, frame]);
  }

  return frames.sort((a, b) => a[0] - b[0]);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================================
// Text Report Generation
// ============================================================================

function generateTextReport(catalogDoc: CatalogDoc): string {
  const lines: string[] = [];
  const divider = "═".repeat(80);
  const thinDivider = "─".repeat(80);
  const stats = getFrameStats(catalogDoc);
  const meta = catalogDoc.meta;

  // Header
  lines.push(divider);
  lines.push(`  CAN CATALOG REPORT — ${meta?.name ?? "Untitled"}`);
  lines.push(divider);
  lines.push("");

  // Summary
  lines.push("SUMMARY");
  lines.push(thinDivider);
  if (meta?.version) lines.push(`  Version:            ${meta.version}`);
  if (meta?.role) lines.push(`  Role:               ${meta.role}`);
  lines.push(`  Default Endianness: ${meta?.default_endianness ?? "little"}`);
  lines.push(`  Frames:             ${stats.frameCount} (${stats.muxFrameCount} mux)`);
  lines.push(`  Signals:            ${stats.signalCount} (${stats.enumSignalCount} enums)`);
  lines.push("");
  lines.push(`  Confidence: ${stats.highConfidence} high, ${stats.mediumConfidence} medium, ${stats.lowConfidence} low, ${stats.noConfidence} none`);
  lines.push("");

  // Frames
  lines.push("FRAMES");
  lines.push(divider);

  const defaultEndian = meta?.default_endianness ?? "little";
  const defaultInterval = meta?.default_interval;
  const sortedFrames = getSortedFrames(catalogDoc);

  for (const [id, , frame] of sortedFrames) {
    lines.push("");
    const frameId = formatFrameId(id);
    const name = frame.name ? ` — ${frame.name}` : "";
    lines.push(`╔══ ${frameId}${name} ${"═".repeat(Math.max(0, 60 - frameId.length - name.length))}`);

    if (frame.length) lines.push(`║  Length: ${frame.length}`);
    const transmitter = formatTransmitter(frame.transmitter);
    if (transmitter) lines.push(`║  Transmitter: ${transmitter}`);
    const interval = getFrameInterval(frame, defaultInterval);
    if (interval.value !== undefined) {
      lines.push(`║  Interval: ${interval.value}ms${interval.isDefault ? ' (default)' : ''}`);
    }
    if (frame.bus) lines.push(`║  Bus: ${frame.bus}`);

    // Plain signals
    if (frame.signals && frame.signals.length > 0) {
      lines.push("║");
      lines.push("║  Signals:");
      lines.push("║  " + "-".repeat(70));
      lines.push("║  Bit Range    Signal                          Scale        Unit   Conf");
      lines.push("║  " + "-".repeat(70));
      for (const sig of frame.signals) {
        const bitRange = `${sig.start_bit}/${sig.bit_length}`.padEnd(12);
        const sigName = sig.name.substring(0, 30).padEnd(30);
        const scale = formatScale(sig.factor, sig.offset).padEnd(12);
        const unit = (sig.unit ?? "").padEnd(6);
        const conf = getConfidenceLabel(sig.confidence);
        lines.push(`║  ${bitRange}  ${sigName}  ${scale}  ${unit}  ${conf}`);
      }
    }

    // Multiplexed signals
    if (frame.mux) {
      const muxes = Array.isArray(frame.mux) ? frame.mux : [frame.mux];
      for (const mux of muxes) {
        lines.push("║");
        renderMuxText(mux, lines, defaultEndian, 1);
      }
    }

    lines.push("╚" + "═".repeat(70));
  }

  lines.push("");
  lines.push(divider);
  lines.push("  Generated by WireTAP");
  lines.push(divider);

  return lines.join("\n");
}

function renderMuxText(mux: MuxDoc, lines: string[], defaultEndian: string, level: number): void {
  const indent = "║" + "  ".repeat(level);
  const muxName = mux.name ? ` (${mux.name})` : "";
  lines.push(`${indent}MUX @ bit ${mux.start_bit}/${mux.bit_length}${muxName}:`);

  const cases = getMuxCases(mux);
  for (const [caseVal, muxCase] of cases) {
    lines.push(`${indent}  Case 0x${parseInt(caseVal).toString(16).toUpperCase()}:`);

    if (muxCase.signals) {
      for (const sig of muxCase.signals) {
        const bitRange = `${sig.start_bit}/${sig.bit_length}`.padEnd(10);
        const sigName = sig.name.substring(0, 25).padEnd(25);
        const conf = getConfidenceLabel(sig.confidence);
        lines.push(`${indent}    ${bitRange}  ${sigName}  ${conf}`);
      }
    }

    if (muxCase.mux) {
      renderMuxText(muxCase.mux, lines, defaultEndian, level + 2);
    }
  }
}

// ============================================================================
// Markdown Report Generation
// ============================================================================

function generateMarkdownReport(catalogDoc: CatalogDoc): string {
  const lines: string[] = [];
  const stats = getFrameStats(catalogDoc);
  const meta = catalogDoc.meta;

  lines.push(`# CAN Catalog Report — ${meta?.name ?? "Untitled"}`);
  lines.push("");

  // Summary
  lines.push("## Overview");
  lines.push("");
  lines.push("| Property | Value |");
  lines.push("|----------|-------|");
  if (meta?.version) lines.push(`| Version | ${meta.version} |`);
  if (meta?.role) lines.push(`| Role | ${meta.role} |`);
  lines.push(`| Default Endianness | ${meta?.default_endianness ?? "little"} |`);
  lines.push(`| Frames | ${stats.frameCount} |`);
  lines.push(`| Mux Frames | ${stats.muxFrameCount} |`);
  lines.push(`| Enums | ${stats.enumSignalCount} |`);
  lines.push(`| Signals | ${stats.signalCount} |`);
  lines.push("");
  lines.push("### Signal Confidence");
  lines.push("");
  lines.push(`- **High**: ${stats.highConfidence}`);
  lines.push(`- **Medium**: ${stats.mediumConfidence}`);
  lines.push(`- **Low**: ${stats.lowConfidence}`);
  lines.push(`- **None**: ${stats.noConfidence}`);
  lines.push("");

  // Frames
  lines.push("## Frames");
  lines.push("");

  const defaultEndian = meta?.default_endianness ?? "little";
  const defaultInterval = meta?.default_interval;
  const sortedFrames = getSortedFrames(catalogDoc);

  for (const [id, , frame] of sortedFrames) {
    const frameId = formatFrameId(id);
    const name = frame.name ? ` — ${frame.name}` : "";
    lines.push(`### ${frameId}${name}`);
    lines.push("");

    const parts: string[] = [];
    if (frame.length) parts.push(`Length: ${frame.length}`);
    const transmitter = formatTransmitter(frame.transmitter);
    if (transmitter) parts.push(`Transmitter: ${transmitter}`);
    const interval = getFrameInterval(frame, defaultInterval);
    if (interval.value !== undefined) {
      parts.push(`Interval: ${interval.value}ms${interval.isDefault ? ' (default)' : ''}`);
    }
    if (frame.bus) parts.push(`Bus: ${frame.bus}`);
    if (parts.length > 0) {
      lines.push(`*${parts.join(" | ")}*`);
      lines.push("");
    }

    // Plain signals
    if (frame.signals && frame.signals.length > 0) {
      lines.push("#### Signals");
      lines.push("");
      lines.push("| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |");
      lines.push("|-----------|--------|-------|------|--------|--------|------------|-------|");

      for (const sig of frame.signals) {
        const bitRange = `${sig.start_bit}/${sig.bit_length}`;
        const scale = formatScale(sig.factor, sig.offset);
        const endian = formatEndianness(sig.endianness, defaultEndian);
        const signed = sig.signed ? "yes" : "no";
        const conf = getConfidenceLabel(sig.confidence);
        const notes = formatNotes(sig.notes);
        lines.push(`| ${bitRange} | \`${sig.name}\` | ${scale} | ${sig.unit ?? ""} | ${signed} | ${endian} | ${conf} | ${notes} |`);
      }
      lines.push("");
    }

    // Multiplexed signals
    if (frame.mux) {
      const muxes = Array.isArray(frame.mux) ? frame.mux : [frame.mux];
      for (const mux of muxes) {
        renderMuxMarkdown(mux, lines, defaultEndian, 4);
      }
    }
  }

  lines.push("---");
  lines.push("*Generated by WireTAP*");

  return lines.join("\n");
}

function renderMuxMarkdown(mux: MuxDoc, lines: string[], defaultEndian: string, headingLevel: number): void {
  const heading = "#".repeat(headingLevel);
  const muxName = mux.name ? ` (${mux.name})` : "";
  lines.push(`${heading} Mux @ bit ${mux.start_bit}/${mux.bit_length}${muxName}`);
  lines.push("");

  const cases = getMuxCases(mux);
  for (const [caseVal, muxCase] of cases) {
    const caseHex = `0x${parseInt(caseVal).toString(16).toUpperCase()}`;
    lines.push(`**Case ${caseHex}:**`);
    lines.push("");

    if (muxCase.signals && muxCase.signals.length > 0) {
      lines.push("| Bit Range | Signal | Scale | Unit | Confidence |");
      lines.push("|-----------|--------|-------|------|------------|");

      for (const sig of muxCase.signals) {
        const bitRange = `${sig.start_bit}/${sig.bit_length}`;
        const scale = formatScale(sig.factor, sig.offset);
        const conf = getConfidenceLabel(sig.confidence);
        lines.push(`| ${bitRange} | \`${sig.name}\` | ${scale} | ${sig.unit ?? ""} | ${conf} |`);
      }
      lines.push("");
    }

    if (muxCase.mux) {
      renderMuxMarkdown(muxCase.mux, lines, defaultEndian, Math.min(headingLevel + 1, 6));
    }
  }
}

// ============================================================================
// HTML Report Generation (Unified with Theme Support)
// ============================================================================

function generateHtmlReport(catalogDoc: CatalogDoc, theme: CatalogTheme): string {
  const stats = getFrameStats(catalogDoc);
  const meta = catalogDoc.meta;
  const defaultEndian = meta?.default_endianness ?? "little";
  const isPrint = theme.name === 'print';

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Catalog Report — ${escapeHtml(meta?.name ?? "Untitled")}</title>
  <style>
${theme.baseStyles}
${theme.additionalStyles}
  </style>
</head>
<body>
`;

  if (isPrint) {
    html += `  <h1>Catalog Report — ${escapeHtml(meta?.name ?? "Untitled")}</h1>

  <div class="print-instructions">
    <strong>To save as PDF:</strong> Use your browser's Print function (Ctrl+P / Cmd+P) and select "Save as PDF" as the destination.
  </div>

  <div class="summary-box">
    <div class="summary-grid">
      <div class="stat-item">
        <div class="value">${stats.frameCount}</div>
        <div class="label">Frames</div>
      </div>
      <div class="stat-item">
        <div class="value">${stats.muxFrameCount}</div>
        <div class="label">Mux Frames</div>
      </div>
      <div class="stat-item">
        <div class="value">${stats.enumSignalCount}</div>
        <div class="label">Enums</div>
      </div>
      <div class="stat-item">
        <div class="value">${stats.signalCount}</div>
        <div class="label">Signals</div>
      </div>
    </div>
`;
  } else {
    html += `  <div class="container">
    <h1>Catalog Report — ${escapeHtml(meta?.name ?? "Untitled")}</h1>

    <div class="summary-grid">
      <div class="summary-card">
        <div class="value">${stats.frameCount}</div>
        <div class="label">Frames</div>
      </div>
      <div class="summary-card">
        <div class="value">${stats.muxFrameCount}</div>
        <div class="label">Mux Frames</div>
      </div>
      <div class="summary-card">
        <div class="value">${stats.enumSignalCount}</div>
        <div class="label">Enums</div>
      </div>
      <div class="summary-card">
        <div class="value">${stats.signalCount}</div>
        <div class="label">Signals</div>
      </div>
    </div>
`;
  }

  // Confidence row (shared between themes)
  html += `
    <div class="confidence-row">
      <div class="item">
        <span class="badge conf-high">high</span>
        <span class="count">${stats.highConfidence}</span>
      </div>
      <div class="item">
        <span class="badge conf-medium">medium</span>
        <span class="count">${stats.mediumConfidence}</span>
      </div>
      <div class="item">
        <span class="badge conf-low">low</span>
        <span class="count">${stats.lowConfidence}</span>
      </div>
      <div class="item">
        <span class="badge conf-none">none</span>
        <span class="count">${stats.noConfidence}</span>
      </div>
      <div class="item" style="margin-left: auto;">
        <span class="badge end-default">endian: default (${defaultEndian.toUpperCase()})</span>
      </div>
    </div>
`;

  if (isPrint) {
    html += `  </div>
`;
  }

  const sortedFrames = getSortedFrames(catalogDoc);
  const defaultInterval = meta?.default_interval;

  for (const [id, , frame] of sortedFrames) {
    const frameId = formatFrameId(id);
    const name = frame.name ? ` — ${escapeHtml(frame.name)}` : "";
    const transmitter = formatTransmitter(frame.transmitter);
    const interval = getFrameInterval(frame, defaultInterval);
    const frameSignals = collectAllSignals(frame);
    const frameHigh = frameSignals.filter(s => s.confidence === "high").length;
    const frameMedium = frameSignals.filter(s => s.confidence === "medium").length;
    const frameLow = frameSignals.filter(s => s.confidence === "low").length;
    const frameNone = frameSignals.filter(s => !s.confidence || s.confidence === "none").length;

    const indent = isPrint ? "  " : "    ";

    html += `
${indent}<section class="frame-card">
${indent}  <h2><code>${frameId}</code>${name}</h2>
${indent}  <div class="frame-meta">
${indent}    ${frame.length ? `<span class="pill">len: ${frame.length}</span>` : ''}
${indent}    ${transmitter ? `<span class="pill">tx: ${escapeHtml(transmitter)}</span>` : ''}
${indent}    ${interval.value !== undefined ? `<span class="pill${interval.isDefault ? ' dim' : ''}">${interval.value}ms${interval.isDefault ? ' (default)' : ''}</span>` : ''}
${indent}    ${frame.bus ? `<span class="pill">bus: ${escapeHtml(frame.bus)}</span>` : ''}
${indent}    ${frameHigh > 0 ? `<span class="badge conf-high">high ${frameHigh}</span>` : ''}
${indent}    ${frameMedium > 0 ? `<span class="badge conf-medium">medium ${frameMedium}</span>` : ''}
${indent}    ${frameLow > 0 ? `<span class="badge conf-low">low ${frameLow}</span>` : ''}
${indent}    ${frameNone > 0 ? `<span class="badge conf-none">none ${frameNone}</span>` : ''}
${indent}  </div>
`;

    // Plain signals
    if (frame.signals && frame.signals.length > 0) {
      const showEnum = hasEnumSignals(frame.signals);
      html += `${indent}  <div class="mux-head">Plain signals</div>
${renderSignalsTableHtml(frame.signals, defaultEndian, showEnum, theme)}
`;
    }

    // Multiplexed signals
    if (frame.mux) {
      const muxes = Array.isArray(frame.mux) ? frame.mux : [frame.mux];
      for (const mux of muxes) {
        html += renderMuxHtml(mux, defaultEndian, 1, theme);
      }
    }

    html += `${indent}</section>
`;
  }

  if (isPrint) {
    html += `
  <div class="footer">
    Generated by WireTAP
  </div>
</body>
</html>`;
  } else {
    html += `
    <div class="footer">
      Generated by WireTAP
    </div>
  </div>
</body>
</html>`;
  }

  return html;
}

function renderSignalsTableHtml(signals: SignalDoc[], defaultEndian: string, showEnum: boolean, theme: CatalogTheme): string {
  let html = `
      <table class="signals-table">
        <thead>
          <tr>
            <th class="nwrap">bit range</th>
            <th>signal</th>
            <th class="nwrap">scale</th>
            <th class="nwrap">unit</th>
            <th class="nwrap">signed</th>
            <th class="nwrap">endian</th>
            ${showEnum ? '<th>enum</th>' : ''}
            <th class="nwrap">confidence</th>
            <th>notes</th>
          </tr>
        </thead>
        <tbody>
`;
  for (const sig of signals) {
    html += renderSignalRowHtml(sig, defaultEndian, showEnum, theme);
  }
  html += `
        </tbody>
      </table>
`;
  return html;
}

function renderSignalRowHtml(sig: SignalDoc, defaultEndian: string, showEnum: boolean, theme: CatalogTheme): string {
  const bitRange = `${sig.start_bit}/${sig.bit_length}`;
  const endian = formatEndianness(sig.endianness, defaultEndian);
  const endianClass = sig.endianness ? "end-override" : "end-default";
  const signed = sig.signed ? "yes" : "no";
  const conf = getConfidenceLabel(sig.confidence);
  const enumStr = formatEnumValues(sig.enum);
  const notes = formatNotes(sig.notes);

  const enumStyle = theme.styles.enumFontSize ? ` style="${theme.styles.enumFontSize}"` : '';
  const notesStyle = theme.styles.notesFontSize ? ` style="${theme.styles.notesFontSize}"` : '';

  return `
          <tr>
            <td class="nwrap">${bitRange}</td>
            <td><code>${escapeHtml(sig.name)}</code></td>
            <td class="nwrap dim">x${sig.factor ?? 1} + ${sig.offset ?? 0}</td>
            <td class="nwrap">${escapeHtml(sig.unit ?? "")}</td>
            <td class="nwrap">${signed}</td>
            <td class="nwrap"><span class="badge ${endianClass}">${endian}</span></td>
            ${showEnum ? `<td${enumStyle}>${escapeHtml(enumStr)}</td>` : ''}
            <td class="nwrap"><span class="badge conf-${conf}">${conf}</span></td>
            <td class="dim"${notesStyle}>${escapeHtml(notes)}</td>
          </tr>
`;
}

function renderMuxHtml(mux: MuxDoc, defaultEndian: string, level: number, theme: CatalogTheme): string {
  const levelClass = level > 1 ? ` l${Math.min(level, 4)}` : "";
  const muxName = mux.name ? ` (${escapeHtml(mux.name)})` : "";

  let html = `
      <div class="mux-block${levelClass}">
        <div class="mux-head">Mux @ bit ${mux.start_bit}/${mux.bit_length}${muxName}</div>
`;

  const cases = getMuxCases(mux);
  const { muxMarginLeft, muxMarginBottom, caseFontSize, caseMarginBottom } = theme.styles;
  const caseStyle = caseFontSize ? ` ${caseFontSize}` : '';

  for (const [caseVal, muxCase] of cases) {
    const caseHex = `0x${parseInt(caseVal).toString(16).toUpperCase()}`;
    html += `
        <div style="margin-left: ${muxMarginLeft}; margin-bottom: ${muxMarginBottom};">
          <div style="font-weight: 500; color: var(--text-secondary);${caseStyle} margin-bottom: ${caseMarginBottom};">Case ${caseHex}</div>
`;

    if (muxCase.signals && muxCase.signals.length > 0) {
      const showEnum = hasEnumSignals(muxCase.signals);
      html += renderSignalsTableHtml(muxCase.signals, defaultEndian, showEnum, theme);
    }

    if (muxCase.mux) {
      html += renderMuxHtml(muxCase.mux, defaultEndian, level + 1, theme);
    }

    html += `
        </div>
`;
  }

  html += `
      </div>
`;
  return html;
}

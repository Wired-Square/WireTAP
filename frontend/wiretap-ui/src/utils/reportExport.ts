// ui/src/utils/reportExport.ts
// Centralized report export utilities

import {
  TEXT_FILTERS,
  MARKDOWN_FILTERS,
  HTML_FILTERS,
  JSON_FILTERS,
  type DialogFilter,
} from "../api/dialogs";

export type ExportFormat = "text" | "markdown" | "html-screen" | "html-print" | "json";

export const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  text: ".txt",
  markdown: ".md",
  "html-screen": ".html",
  "html-print": ".html",
  json: ".json",
};

export const FORMAT_DESCRIPTIONS: Record<ExportFormat, string> = {
  text: "Plain text report with visual formatting",
  markdown: "Structured markdown with tables and sections",
  "html-screen": "Rich HTML with dark theme colors and styling",
  "html-print": "Light theme HTML optimized for printing or PDF export",
  json: "Raw JSON data for programmatic processing",
};

export const FORMAT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "markdown", label: "Markdown" },
  { value: "html-screen", label: "HTML (Screen Optimised)" },
  { value: "html-print", label: "HTML (Print Optimised)" },
  { value: "json", label: "JSON" },
];

/**
 * Get date prefix in reverse ISO format (YYYYMMDD-)
 */
export function getDatePrefix(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}${month}${day}-`;
}

/**
 * Get full filename with date prefix and correct extension
 */
export function getFullFilename(filename: string, format: ExportFormat): string {
  const ext = FORMAT_EXTENSIONS[format];
  const datePrefix = getDatePrefix();
  const prefixedFilename = filename.startsWith(datePrefix) ? filename : `${datePrefix}${filename}`;
  return prefixedFilename.endsWith(ext) ? prefixedFilename : `${prefixedFilename}${ext}`;
}

/**
 * Get dialog filter for a given export format
 */
export function getFilterForFormat(format: ExportFormat): DialogFilter[] {
  switch (format) {
    case "text":
      return TEXT_FILTERS;
    case "markdown":
      return MARKDOWN_FILTERS;
    case "html-screen":
    case "html-print":
      return HTML_FILTERS;
    case "json":
      return JSON_FILTERS;
  }
}

/**
 * Format milliseconds in human-readable form
 */
export function formatMs(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${ms.toFixed(1)}ms`;
}

// ============================================================================
// Common HTML styles for reports
// ============================================================================

export const DARK_THEME_STYLES = `
    :root {
      --bg-primary: #0f172a;
      --bg-secondary: #1e293b;
      --bg-card: #334155;
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --accent-purple: #a855f7;
      --accent-pink: #ec4899;
      --accent-cyan: #22d3ee;
      --accent-orange: #f97316;
      --accent-green: #22c55e;
      --accent-yellow: #eab308;
      --border: #475569;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
      padding: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 {
      font-size: 2rem;
      margin-bottom: 1rem;
      background: linear-gradient(135deg, var(--accent-purple), var(--accent-pink));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    h2 { font-size: 1.5rem; margin: 2rem 0 1rem; color: var(--accent-purple); }
    h3 { font-size: 1.2rem; margin: 1.5rem 0 0.5rem; color: var(--text-primary); }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
      margin: 1rem 0;
    }
    .summary-card {
      background: var(--bg-secondary);
      border-radius: 8px;
      padding: 1rem;
      text-align: center;
      border: 1px solid var(--border);
    }
    .summary-card .value {
      font-size: 2rem;
      font-weight: bold;
      color: var(--accent-cyan);
    }
    .summary-card .label {
      font-size: 0.875rem;
      color: var(--text-secondary);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 500;
    }
    .badge-purple { background: rgba(168, 85, 247, 0.2); color: #c084fc; }
    .badge-cyan { background: rgba(34, 211, 238, 0.2); color: #22d3ee; }
    .badge-orange { background: rgba(249, 115, 22, 0.2); color: #fb923c; }
    .badge-green { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .badge-pink { background: rgba(236, 72, 153, 0.2); color: #f472b6; }
    .badge-yellow { background: rgba(234, 179, 8, 0.2); color: #facc15; }
    .badge-slate { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 0.5rem 0;
      font-size: 0.875rem;
    }
    th, td {
      padding: 0.5rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th { color: var(--text-secondary); font-weight: 500; }
    .section-card {
      background: var(--bg-secondary);
      border-radius: 8px;
      padding: 1rem;
      margin: 1rem 0;
      border: 1px solid var(--border);
    }
    .frame-id { font-family: monospace; font-weight: bold; color: var(--accent-purple); }
    .footer {
      margin-top: 2rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
      text-align: center;
      color: var(--text-secondary);
      font-size: 0.875rem;
    }
`;

export const PRINT_THEME_STYLES = `
    :root {
      --text-primary: #1e293b;
      --text-secondary: #64748b;
      --text-muted: #94a3b8;
      --border: #e2e8f0;
      --bg-light: #f8fafc;
      --accent: #7c3aed;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      color: var(--text-primary);
      line-height: 1.5;
      padding: 20mm;
      max-width: 210mm;
      margin: 0 auto;
    }

    @media print {
      body { padding: 0; max-width: none; }
      .page-break { page-break-before: always; }
      .no-break { page-break-inside: avoid; }
      @page { margin: 15mm; size: A4; }
    }

    h1 {
      font-size: 24pt;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 8pt;
      border-bottom: 2pt solid var(--accent);
      padding-bottom: 8pt;
    }

    h2 {
      font-size: 14pt;
      font-weight: 600;
      color: var(--text-primary);
      margin: 16pt 0 8pt;
      border-bottom: 1pt solid var(--border);
      padding-bottom: 4pt;
    }

    h3 {
      font-size: 11pt;
      font-weight: 600;
      color: var(--text-secondary);
      margin: 10pt 0 4pt;
    }

    .summary-box {
      background: var(--bg-light);
      border: 1pt solid var(--border);
      border-radius: 4pt;
      padding: 12pt;
      margin: 12pt 0;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12pt;
      text-align: center;
    }

    .stat-item .value {
      font-size: 18pt;
      font-weight: 700;
      color: var(--accent);
    }

    .stat-item .label {
      font-size: 8pt;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5pt;
    }

    .badge {
      display: inline-block;
      font-size: 8pt;
      padding: 2pt 6pt;
      border-radius: 2pt;
      font-weight: 500;
    }

    .badge-purple { background: #f3e8ff; color: #7c3aed; }
    .badge-cyan { background: #cffafe; color: #0e7490; }
    .badge-orange { background: #ffedd5; color: #c2410c; }
    .badge-green { background: #dcfce7; color: #166534; }
    .badge-pink { background: #fce7f3; color: #be185d; }
    .badge-slate { background: #f1f5f9; color: #475569; }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 9pt;
      margin: 6pt 0;
    }

    th, td {
      padding: 4pt 6pt;
      text-align: left;
      border: 0.5pt solid var(--border);
    }

    th {
      background: var(--bg-light);
      font-weight: 600;
      color: var(--text-secondary);
    }

    code {
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 8pt;
      background: var(--bg-light);
      padding: 1pt 3pt;
      border-radius: 2pt;
    }

    .section-card {
      border: 1pt solid var(--border);
      border-radius: 4pt;
      padding: 10pt;
      margin: 8pt 0;
      background: white;
    }

    .frame-id {
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 10pt;
      font-weight: 700;
      color: var(--accent);
    }

    .footer {
      margin-top: 20pt;
      padding-top: 10pt;
      border-top: 1pt solid var(--border);
      text-align: center;
      font-size: 8pt;
      color: var(--text-muted);
    }

    .print-instructions {
      background: #eff6ff;
      border: 1pt solid #bfdbfe;
      border-radius: 4pt;
      padding: 10pt;
      margin: 12pt 0;
      font-size: 9pt;
      color: #1e40af;
    }

    @media print {
      .print-instructions { display: none; }
    }
`;

// ============================================================================
// Catalog Report Styles
// ============================================================================

export const CATALOG_SCREEN_ADDITIONAL_STYLES = `
    /* Confidence badges */
    .conf-high { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .conf-medium { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
    .conf-low { background: rgba(234, 179, 8, 0.2); color: #facc15; }
    .conf-none { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }

    /* Confidence row */
    .confidence-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--border);
    }
    .confidence-row .item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.85rem;
    }
    .confidence-row .count {
      font-weight: 600;
      color: var(--text-primary);
    }

    /* Endianness badges */
    .end-default { background: rgba(100, 116, 139, 0.3); color: #cbd5e1; }
    .end-override { background: rgba(239, 68, 68, 0.2); color: #f87171; }

    /* Frame cards */
    .frame-card {
      background: var(--bg-secondary);
      border-radius: 10px;
      margin: 16px 0;
      padding: 12px 12px 8px;
      border: 1px solid var(--border);
    }
    .frame-card h2 {
      margin: 0 0 4px;
      font-size: 16px;
    }
    .frame-card h2 code {
      color: var(--accent-purple);
      font-size: 1.1em;
    }
    .frame-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      margin: 2px 0 10px;
      flex-wrap: wrap;
    }
    .frame-meta .pill {
      background: var(--bg-card);
      border: 1px solid var(--border);
      padding: 2px 6px;
      border-radius: 6px;
      color: var(--text-secondary);
      font-size: 0.8rem;
    }

    /* Signal tables */
    .signals-table {
      width: 100%;
      border-collapse: collapse;
      margin: 6px 0 10px;
      font-size: 0.875rem;
    }
    .signals-table th,
    .signals-table td {
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
      text-align: left;
    }
    .signals-table th {
      color: var(--text-secondary);
      font-weight: 600;
      white-space: nowrap;
    }
    .signals-table .nwrap { white-space: nowrap; }
    .signals-table .dim { color: var(--text-secondary); }
    .signals-table code { color: var(--text-primary); }

    /* Mux blocks */
    .mux-block {
      border-left: 4px solid var(--accent-green);
      background: linear-gradient(90deg, rgba(34, 197, 94, 0.1) 0, transparent 320px);
      padding: 6px 8px 0;
      margin: 10px 0 6px;
      border-radius: 6px;
    }
    .mux-block.l2 {
      border-left-color: var(--accent-cyan);
      background: linear-gradient(90deg, rgba(34, 211, 238, 0.1) 0, transparent 320px);
    }
    .mux-block.l3 {
      border-left-color: var(--accent-orange);
      background: linear-gradient(90deg, rgba(249, 115, 22, 0.1) 0, transparent 320px);
    }
    .mux-block.l4 {
      border-left-color: var(--accent-purple);
      background: linear-gradient(90deg, rgba(168, 85, 247, 0.1) 0, transparent 320px);
    }
    .mux-head {
      font-weight: 600;
      margin: 0 0 6px;
      color: var(--text-primary);
    }

    /* Legend */
    .legend {
      margin: 8px 0 20px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 0.85rem;
    }
    .legend .badge {
      padding: 2px 8px;
      border-radius: 999px;
    }
`;

export const CATALOG_PRINT_ADDITIONAL_STYLES = `
    /* Confidence badges */
    .conf-high { background: #dcfce7; color: #166534; }
    .conf-medium { background: #dbeafe; color: #1e40af; }
    .conf-low { background: #fef3c7; color: #92400e; }
    .conf-none { background: #f1f5f9; color: #475569; }

    /* Confidence row */
    .confidence-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8pt;
      margin-top: 6pt;
      padding-top: 6pt;
      border-top: 0.5pt solid var(--border);
      font-size: 7pt;
    }
    .confidence-row .item {
      display: flex;
      align-items: center;
      gap: 4pt;
    }
    .confidence-row .count {
      font-weight: 600;
    }

    /* Endianness badges */
    .end-default { background: #e2e8f0; color: #475569; }
    .end-override { background: #fee2e2; color: #b91c1c; }

    /* Frame cards */
    .frame-card {
      border: 1pt solid var(--border);
      border-radius: 4pt;
      margin: 10pt 0;
      padding: 8pt;
      background: white;
      page-break-inside: avoid;
    }
    .frame-card h2 {
      margin: 0 0 4pt;
      font-size: 12pt;
    }
    .frame-card h2 code {
      color: var(--accent);
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
    }
    .frame-meta {
      display: flex;
      gap: 6pt;
      align-items: center;
      margin: 2pt 0 8pt;
      flex-wrap: wrap;
    }
    .frame-meta .pill {
      background: var(--bg-light);
      border: 0.5pt solid var(--border);
      padding: 1pt 4pt;
      border-radius: 3pt;
      color: var(--text-secondary);
      font-size: 8pt;
    }

    /* Signal tables */
    .signals-table {
      width: 100%;
      border-collapse: collapse;
      margin: 4pt 0 8pt;
      font-size: 8pt;
    }
    .signals-table th,
    .signals-table td {
      padding: 3pt 4pt;
      border: 0.5pt solid var(--border);
      vertical-align: top;
      text-align: left;
    }
    .signals-table th {
      background: var(--bg-light);
      font-weight: 600;
      color: var(--text-secondary);
    }
    .signals-table .nwrap { white-space: nowrap; }
    .signals-table .dim { color: var(--text-muted); }
    .signals-table code {
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 7pt;
    }

    /* Mux blocks */
    .mux-block {
      border-left: 2pt solid #16a34a;
      background: #f0fdf4;
      padding: 4pt 6pt 0;
      margin: 6pt 0 4pt;
      border-radius: 3pt;
    }
    .mux-block.l2 {
      border-left-color: #0891b2;
      background: #ecfeff;
    }
    .mux-block.l3 {
      border-left-color: #ea580c;
      background: #fff7ed;
    }
    .mux-block.l4 {
      border-left-color: #9333ea;
      background: #faf5ff;
    }
    .mux-head {
      font-weight: 600;
      margin: 0 0 4pt;
      font-size: 9pt;
      color: var(--text-primary);
    }

    /* Legend */
    .legend {
      margin: 6pt 0 12pt;
      display: flex;
      flex-wrap: wrap;
      gap: 6pt;
      font-size: 7pt;
    }
    .legend .badge {
      padding: 1pt 6pt;
      border-radius: 999pt;
    }
`;

// ============================================================================
// Catalog Report Theme Configuration
// ============================================================================

export interface CatalogTheme {
  name: 'screen' | 'print';
  baseStyles: string;
  additionalStyles: string;
  // Style variations for inline styles in render functions
  styles: {
    enumFontSize: string;      // '' vs 'font-size: 7pt;'
    notesFontSize: string;     // 'font-size: 0.85em;' vs 'font-size: 7pt;'
    muxMarginLeft: string;     // '8px' vs '6pt'
    muxMarginBottom: string;   // '8px' vs '6pt'
    caseFontSize: string;      // '' vs 'font-size: 8pt;'
    caseMarginBottom: string;  // '4px' vs '2pt'
  };
}

export const CATALOG_SCREEN_THEME: CatalogTheme = {
  name: 'screen',
  baseStyles: DARK_THEME_STYLES,
  additionalStyles: CATALOG_SCREEN_ADDITIONAL_STYLES,
  styles: {
    enumFontSize: '',
    notesFontSize: 'font-size: 0.85em;',
    muxMarginLeft: '8px',
    muxMarginBottom: '8px',
    caseFontSize: '',
    caseMarginBottom: '4px',
  },
};

export const CATALOG_PRINT_THEME: CatalogTheme = {
  name: 'print',
  baseStyles: PRINT_THEME_STYLES,
  additionalStyles: CATALOG_PRINT_ADDITIONAL_STYLES,
  styles: {
    enumFontSize: 'font-size: 7pt;',
    notesFontSize: 'font-size: 7pt;',
    muxMarginLeft: '6pt',
    muxMarginBottom: '6pt',
    caseFontSize: 'font-size: 8pt;',
    caseMarginBottom: '2pt',
  },
};

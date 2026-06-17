// ui/src/apps/catalog/views/DiffView.tsx
//
// Read-only inline unified diff of the working buffer against the last-saved
// baseline. The diff itself is computed in Rust (`catalog.diff`) and cached on
// the store, so this view just renders the rows.

import { useTranslation } from "react-i18next";
import type { DiffLine } from "../../../api/catalog";
import {
  bgPrimary,
  bgSurface,
  bgSuccess,
  bgDanger,
  textPrimary,
  textMuted,
  textSuccess,
  textDanger,
} from "../../../styles/colourTokens";

export type DiffViewProps = {
  lines: DiffLine[];
};

const MARK: Record<DiffLine["kind"], string> = { context: " ", add: "+", remove: "-" };

function rowClasses(kind: DiffLine["kind"]): string {
  if (kind === "add") return `${bgSuccess} ${textSuccess}`;
  if (kind === "remove") return `${bgDanger} ${textDanger}`;
  return textPrimary;
}

export default function DiffView({ lines }: DiffViewProps) {
  const { t } = useTranslation("catalog");

  if (lines.length === 0) {
    return (
      <div className={`flex-1 flex items-center justify-center ${bgPrimary} ${textMuted} text-sm`}>
        {t("editor.diffNoChanges", "No changes since last save")}
      </div>
    );
  }

  const gutterWidth = `${Math.max(3, String(lines.length).length + 1)}ch`;

  return (
    <div className={`flex-1 min-h-0 overflow-auto font-mono text-sm ${bgPrimary}`}>
      {lines.map((line, i) => (
        <div key={i} className={`flex leading-[1.5rem] ${rowClasses(line.kind)}`}>
          <span
            className={`flex-shrink-0 px-2 text-right ${bgSurface} ${textMuted} select-none`}
            style={{ minWidth: gutterWidth }}
            aria-hidden="true"
          >
            {line.oldLine ?? ""}
          </span>
          <span
            className={`flex-shrink-0 px-2 text-right ${bgSurface} ${textMuted} select-none`}
            style={{ minWidth: gutterWidth }}
            aria-hidden="true"
          >
            {line.newLine ?? ""}
          </span>
          <span className="flex-shrink-0 w-4 text-center select-none">{MARK[line.kind]}</span>
          <span className="whitespace-pre-wrap break-all pr-4">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

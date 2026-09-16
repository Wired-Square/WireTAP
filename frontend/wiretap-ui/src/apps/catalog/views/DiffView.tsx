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
  borderDefault,
  borderSuccess,
  borderDanger,
  textPrimary,
  textMuted,
  textSuccess,
  textDanger,
} from "../../../styles/colourTokens";

export type DiffViewProps = {
  lines: DiffLine[];
};

type Kind = DiffLine["kind"];

const MARK: Record<Kind, string> = { context: " ", add: "+", remove: "-" };

/** Change tint painted on the content side of a row (translucent over bgPrimary). */
function rowTint(kind: Kind): string {
  if (kind === "add") return bgSuccess;
  if (kind === "remove") return bgDanger;
  return "";
}

/** Coloured left accent so the change boundary reads even with an opaque gutter. */
function accentBorder(kind: Kind): string {
  if (kind === "add") return borderSuccess;
  if (kind === "remove") return borderDanger;
  return "border-transparent";
}

function markerColour(kind: Kind): string {
  if (kind === "add") return textSuccess;
  if (kind === "remove") return textDanger;
  return textMuted;
}

function contentText(kind: Kind): string {
  if (kind === "add") return textSuccess;
  if (kind === "remove") return textDanger;
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

  // Fixed gutter width so both number columns form clean, aligned columns.
  const numColWidth = `${String(lines.length).length}ch`;

  return (
    <div className={`flex-1 min-h-0 overflow-auto font-mono text-sm ${bgPrimary}`}>
      {lines.map((line, i) => (
        <div
          key={i}
          className={`flex w-max min-w-full leading-[1.5rem] border-l-2 ${accentBorder(line.kind)} ${rowTint(line.kind)}`}
        >
          {/* Pinned gutter — opaque so content scrolling under it never bleeds through. */}
          <span
            className={`sticky left-0 z-10 flex flex-shrink-0 items-center gap-2 px-2 border-r ${borderDefault} ${bgSurface} select-none`}
            aria-hidden="true"
          >
            <span className={`text-right tabular-nums ${textMuted}`} style={{ width: numColWidth }}>
              {line.oldLine ?? ""}
            </span>
            <span className={`text-right tabular-nums ${textMuted}`} style={{ width: numColWidth }}>
              {line.newLine ?? ""}
            </span>
            <span className={`w-4 text-center ${markerColour(line.kind)}`}>{MARK[line.kind]}</span>
          </span>
          <span className={`whitespace-pre pl-3 pr-4 [tab-size:4] ${contentText(line.kind)}`}>
            {line.text}
          </span>
        </div>
      ))}
    </div>
  );
}

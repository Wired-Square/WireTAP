// ui/src/components/Alert.tsx
//
// The alert row: a tinted box, one glyph, and whatever you put in it.
//
// **The glyph is not a prop.** Tone already says how bad it is, and letting each
// caller choose a picture is exactly how this journey accumulated four glyphs for one
// job — `XCircle`, `TriangleAlert`, `ShieldAlert` and `Shield` all meaning "something
// is wrong", in dialogs one click apart. `ShareIcon.Alert` is the single answer, and
// this file previously held its own four-variant icon map that contradicted it.
//
// Box tint and glyph tint come from the one `tone`, so they cannot drift. Six sites
// used to pair them by hand, where a mismatch was invisible to grep.
//
// Only the two tones anything actually uses. `info` and `success` alert boxes existed
// here before and had no callers; a tone with no site is a tone nobody has designed.

import type { ReactNode } from "react";
import * as ShareIcon from "./catalogIcons";
import { iconMd } from "../styles/spacing";
import { alertDanger, alertWarning } from "../styles/cardStyles";
import { textDanger, textWarning } from "../styles/colourTokens";

export type AlertTone = "warning" | "danger";

const BOX: Record<AlertTone, string> = { warning: alertWarning, danger: alertDanger };
const GLYPH: Record<AlertTone, string> = { warning: textWarning, danger: textDanger };

export default function Alert({
  tone,
  action,
  children,
}: {
  tone: AlertTone;
  /** Trailing control, right-aligned — a "Connect" button and the like. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`${BOX[tone]} flex items-start gap-2`}>
      <ShareIcon.Alert className={`${iconMd} ${GLYPH[tone]} flex-shrink-0 mt-0.5`} />
      <div className="flex-1">{children}</div>
      {action}
    </div>
  );
}

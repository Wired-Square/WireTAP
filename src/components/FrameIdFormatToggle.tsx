// ui/src/components/FrameIdFormatToggle.tsx
//
// The "Flip" control. A single cycle button that overrides the frame-id display
// format for the current panel: Default (Auto) → Dec → Hex → Default. Reads and
// drives the per-panel FrameIdFormatContext.

import { Hash } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toggleButtonClass } from "../styles/buttonStyles";
import { iconSm } from "../styles/spacing";
import { useFrameIdFormat, nextFrameIdOverride } from "../hooks/useFrameIdFormat";

/** Map a hex/decimal format to its short i18n key (hex/dec). */
const formatKey = (f: "hex" | "decimal") => (f === "hex" ? "frameIdFormat.hex" : "frameIdFormat.dec");

export default function FrameIdFormatToggle() {
  const { t } = useTranslation("common");
  const { override, setOverride, defaultFormat, effective } = useFrameIdFormat();

  const label =
    override === "default"
      ? `${t("frameIdFormat.auto")} · ${t(formatKey(effective)).toUpperCase()}`
      : t(formatKey(override));

  return (
    <button
      onClick={() => setOverride(nextFrameIdOverride(override))}
      className={toggleButtonClass(override !== "default", "blue")}
      title={t("frameIdFormat.tooltip", { default: t(formatKey(defaultFormat)) })}
    >
      <Hash className={`${iconSm} flex-shrink-0`} />
      <span className="ml-1 text-sm">{label}</span>
    </button>
  );
}

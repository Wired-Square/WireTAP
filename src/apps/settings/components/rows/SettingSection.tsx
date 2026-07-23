// ui/src/apps/settings/components/rows/SettingSection.tsx
//
// Titled section wrapper for settings views. Replaces the hand-rolled
// `pt-4 border-t … / h3 / space-y-*` block that recurred across the views.

import type { ReactNode } from "react";
import { h3, helpText, sectionDivider } from "../../../../styles";

interface SettingSectionProps {
  /** Section heading. Omit for a leading section that needs no title. */
  title?: ReactNode;
  /** Optional descriptive text shown under the heading. */
  description?: ReactNode;
  /** Right-aligned control in the header row (e.g. a "Reset all" button). */
  action?: ReactNode;
  /** Top divider separating this section from the previous one (default true). */
  divider?: boolean;
  className?: string;
  children: ReactNode;
}

export default function SettingSection({
  title,
  description,
  action,
  divider = true,
  className,
  children,
}: SettingSectionProps) {
  const wrapper = [divider ? sectionDivider : "", className].filter(Boolean).join(" ");
  return (
    <section className={wrapper || undefined}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-4 mb-4">
          {title ? <h3 className={h3}>{title}</h3> : <span />}
          {action}
        </div>
      )}
      {description != null && <p className={`${helpText} mb-4`}>{description}</p>}
      <div className="space-y-4">{children}</div>
    </section>
  );
}

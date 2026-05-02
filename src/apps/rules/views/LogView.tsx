// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useRulesStore } from "../stores/rulesStore";
import {
  textPrimary,
  textSecondary,
  textTertiary,
  textDanger,
  borderDefault,
} from "../../../styles";

export default function LogView() {
  const { t, i18n } = useTranslation("rules");
  const statusLog = useRulesStore((s) => s.statusLog);

  // Newest first.
  const entries = useMemo(() => [...statusLog].reverse(), [statusLog]);

  if (entries.length === 0) {
    return (
      <div className={`text-sm ${textTertiary}`}>{t("log.empty", "No activity yet")}</div>
    );
  }

  return (
    <div className="space-y-2">
      <span className={`text-xs ${textSecondary}`}>
        {t("log.count", { count: entries.length, defaultValue: "{{count}} entries" })}
      </span>

      <div className={`divide-y ${borderDefault} border ${borderDefault} rounded`}>
        {entries.map((entry, idx) => {
          const dotClass =
            entry.type === "success"
              ? "bg-[var(--status-success-text)]"
              : entry.type === "error"
                ? "bg-[var(--status-danger-text)]"
                : "bg-[var(--status-info-text)]";
          const textClass = entry.type === "error" ? textDanger : textPrimary;
          return (
            <div
              key={`${entry.timestamp}-${idx}`}
              className="flex items-start gap-2 px-3 py-2 text-xs"
            >
              <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
              <span className={`flex-1 min-w-0 break-words ${textClass}`}>
                {entry.text}
              </span>
              <span className={`shrink-0 font-mono ${textTertiary}`}>
                {new Date(entry.timestamp).toLocaleTimeString(i18n.language)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

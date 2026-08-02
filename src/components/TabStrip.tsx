// ui/src/components/TabStrip.tsx
//
// The underlined tab strip used inside dialogs.
//
// Generic over the tab id so each caller keeps its own exhaustively-checked union —
// the strip never sees a bare string. Three callers today, and they must stay in
// visual lockstep, which is the whole reason this is one component rather than three
// copies of the same six Tailwind strings.

import type { ReactNode } from "react";

/** Dot colours, keyed by the app's tone vocabulary rather than a private one. */
const DOT = {
  danger: "bg-[var(--status-danger-text)]",
  warning: "bg-[var(--status-warning-text)]",
  info: "bg-[var(--status-info-text)]",
} as const;

export type TabDef<Id extends string> = {
  id: Id;
  label: string;
  icon?: ReactNode;
  /** A dot after the label. Callers map their own semantics onto a tone. */
  tone?: keyof typeof DOT;
  /** Trailing count or short detail. Falsy — including `0` — renders nothing. */
  badge?: string | number;
  /** Present means the tab is disabled *and* says why; absent means enabled. */
  disabledReason?: string;
};

type Props<Id extends string> = {
  tabs: TabDef<Id>[];
  activeTab: Id;
  onTabChange: (tab: Id) => void;
  /** Pin the strip when the panel below it is the page's scroller, not its own. */
  sticky?: boolean;
};

export default function TabStrip<Id extends string>({
  tabs,
  activeTab,
  onTabChange,
  sticky = false,
}: Props<Id>) {
  return (
    <div
      className={`flex border-b border-[color:var(--border-default)] px-2 bg-[var(--bg-surface)] ${
        sticky ? "sticky top-0 z-10" : ""
      }`}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            disabled={!!tab.disabledReason}
            title={tab.disabledReason}
            className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed ${
              isActive
                ? "text-[color:var(--status-info-text)] border-[color:var(--status-info-text)]"
                : "text-[color:var(--text-secondary)] border-transparent enabled:hover:brightness-110"
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.tone && (
              <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${DOT[tab.tone]}`}
              />
            )}
            {/* Truthiness, not `!== undefined`: a zero count is not a badge, and that
                rule belongs here rather than in every caller's tab definition. */}
            {!!tab.badge && (
              <span className="text-[color:var(--text-muted)] tabular-nums">{tab.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

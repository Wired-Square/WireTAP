// ui/src/dialogs/io-source-picker/SourceTabs.tsx
//
// Lightweight tab strip for the Data Source dialog. Splits the source list into
// Captures / Devices. Live/active sessions are rendered above this strip and are
// not a tab.

import type { ReactNode } from "react";

export type SourceTab = "sessions" | "captures" | "devices";

interface TabDef {
  id: SourceTab;
  label: string;
  icon: ReactNode;
  count?: number;
}

interface Props {
  tabs: TabDef[];
  activeTab: SourceTab;
  onTabChange: (tab: SourceTab) => void;
}

export default function SourceTabs({ tabs, activeTab, onTabChange }: Props) {
  return (
    <div className="flex border-b border-[color:var(--border-default)] px-2 sticky top-0 z-10 bg-[var(--bg-surface)]">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
              isActive
                ? "text-[color:var(--status-info-text)] border-[color:var(--status-info-text)]"
                : "text-[color:var(--text-secondary)] border-transparent hover:brightness-110"
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.count !== undefined && tab.count > 0 && (
              <span className="text-[color:var(--text-muted)]">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

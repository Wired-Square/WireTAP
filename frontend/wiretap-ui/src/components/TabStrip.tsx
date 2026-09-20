// ui/src/components/TabStrip.tsx
//
// The tab strip inside dialogs, from a list of tab definitions.
//
// Generic over the tab id so each caller keeps its own exhaustively-checked union —
// the strip never sees a bare string.

import type { ReactNode } from "react";
import { Tab, TabCount, TabDot, Tabs, type TabDotTone } from "./Tabs";

export type TabDef<Id extends string> = {
  id: Id;
  label: string;
  icon?: ReactNode;
  /** A dot after the label. Callers map their own semantics onto a tone. */
  tone?: TabDotTone;
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
    <Tabs className={`px-2 bg-surface ${sticky ? "sticky top-0 z-10" : ""}`}>
      {tabs.map((tab) => (
        <Tab
          key={tab.id}
          selected={tab.id === activeTab}
          onClick={() => onTabChange(tab.id)}
          disabled={!!tab.disabledReason}
          title={tab.disabledReason}
        >
          {tab.icon}
          <span>{tab.label}</span>
          {tab.tone && <TabDot tone={tab.tone} />}
          {/* Truthiness, not `!== undefined`: a zero count is not a badge, and that
              rule belongs here rather than in every caller's tab definition. */}
          {!!tab.badge && <TabCount>{tab.badge}</TabCount>}
        </Tab>
      ))}
    </Tabs>
  );
}

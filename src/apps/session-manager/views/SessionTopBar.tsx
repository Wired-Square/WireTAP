// src/apps/session-manager/views/SessionTopBar.tsx

import { Network, RefreshCw, ToggleLeft, ToggleRight } from "lucide-react";
import { useSessionManagerStore } from "../stores/sessionManagerStore";
import { iconLg, iconMd } from "../../../styles/spacing";
import { iconButtonHover } from "../../../styles/buttonStyles";
import FlexSeparator from "../../../components/FlexSeparator";

interface SessionTopBarProps {
  sessionCount: number;
  onRefresh: () => void;
}

export default function SessionTopBar({ sessionCount, onRefresh }: SessionTopBarProps) {
  const isRefreshing = useSessionManagerStore((s) => s.isRefreshing);
  const autoRefresh = useSessionManagerStore((s) => s.autoRefresh);
  const setAutoRefresh = useSessionManagerStore((s) => s.setAutoRefresh);

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-[color:var(--border-default)] bg-[var(--bg-surface)]">
      {/* Left: Icon, title, count, and separator */}
      <div className="flex items-center gap-3">
        <Network className={`${iconLg} text-cyan-400 shrink-0`} />
        <FlexSeparator />
        <span className="px-2 py-0.5 text-xs rounded-full bg-cyan-500/20 text-cyan-400">
          {sessionCount} active
        </span>
      </div>

      {/* Right: Controls */}
      <div className="flex items-center gap-2">
        {/* Auto-refresh toggle */}
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${iconButtonHover}`}
          title={autoRefresh ? "Disable auto-refresh" : "Enable auto-refresh"}
        >
          {autoRefresh ? (
            <ToggleRight className={`${iconMd} text-green-400`} />
          ) : (
            <ToggleLeft className={`${iconMd} text-[color:var(--text-muted)]`} />
          )}
          <span className="text-[color:var(--text-secondary)]">Auto</span>
        </button>

        {/* Manual refresh */}
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className={`p-1.5 rounded ${iconButtonHover} disabled:opacity-50`}
          title="Refresh sessions"
        >
          <RefreshCw
            className={`${iconMd} text-[color:var(--text-secondary)] ${
              isRefreshing ? "animate-spin" : ""
            }`}
          />
        </button>
      </div>
    </div>
  );
}

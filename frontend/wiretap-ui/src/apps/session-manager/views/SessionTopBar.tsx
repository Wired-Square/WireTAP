// src/apps/session-manager/views/SessionTopBar.tsx

import { RefreshCw, ToggleLeft, ToggleRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSessionManagerStore } from "../stores/sessionManagerStore";
import { iconLg, iconMd } from "../../../styles/spacing";
import FlexSeparator from "../../../components/FlexSeparator";
import { Button, IconButton } from "../../../components/Button";
import { AppIcon } from "../../../components/AppIcon";
import { Badge } from "../../../components/Badge";

interface SessionTopBarProps {
  sessionCount: number;
  onRefresh: () => void;
}

export default function SessionTopBar({ sessionCount, onRefresh }: SessionTopBarProps) {
  const { t } = useTranslation("sessionManager");
  const isRefreshing = useSessionManagerStore((s) => s.isRefreshing);
  const autoRefresh = useSessionManagerStore((s) => s.autoRefresh);
  const setAutoRefresh = useSessionManagerStore((s) => s.setAutoRefresh);

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-[color:var(--border-default)] bg-[var(--bg-surface)]">
      {/* Left: Icon, title, count, and separator */}
      <div className="flex items-center gap-3">
        <AppIcon app="session-manager" className={iconLg} />
        <FlexSeparator />
        <Badge tone="cyan">{t("topBar.activeCount", { count: sessionCount })}</Badge>
      </div>

      {/* Right: Controls */}
      <div className="flex items-center gap-2">
        {/* Auto-refresh toggle */}
        <Button
          onClick={() => setAutoRefresh(!autoRefresh)}
          variant="ghost"
          size="sm"
          title={autoRefresh ? t("topBar.autoRefreshOn") : t("topBar.autoRefreshOff")}
        >
          {autoRefresh ? (
            <ToggleRight className={`${iconMd} text-green-400`} />
          ) : (
            <ToggleLeft className={`${iconMd} text-[color:var(--text-muted)]`} />
          )}
          {t("topBar.auto")}
        </Button>

        {/* Manual refresh */}
        <IconButton
          onClick={onRefresh}
          disabled={isRefreshing}
          title={t("topBar.refresh")}
        >
          <RefreshCw
            className={`${iconMd} text-[color:var(--text-secondary)] ${
              isRefreshing ? "animate-spin" : ""
            }`}
          />
        </IconButton>
      </div>
    </div>
  );
}

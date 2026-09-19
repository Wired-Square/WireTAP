// src/apps/query/views/StatsPanel.tsx
//
// Stats panel showing database activity: running queries and active sessions.
// Allows cancelling queries and terminating sessions.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  RefreshCw,
  XCircle,
  Activity,
  Database,
  Clock,
  User,
  Terminal,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { useQueryStore, type DatabaseActivity } from "../stores/queryStore";
import { emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from "../../../styles/typography";
import { iconSm, iconMd, iconXl } from "../../../styles/spacing";
import {
  borderDivider,
  textPrimary,
  textSecondary,
  textMuted,
  textDataGreen,
  textDataAmber,
  textDanger,
  bgSurface,
} from "../../../styles/colourTokens";
import { Button, IconButton } from "../../../components/Button";
import { Select } from "../../../components/forms";
import { Card } from "../../../components/Card";
import { Table } from "../../../components/Table";

interface Props {
  profileId: string | null;
}

export default function StatsPanel({ profileId }: Props) {
  const { t } = useTranslation("query");
  const activity = useQueryStore((s) => s.activity);
  const refreshActivity = useQueryStore((s) => s.refreshActivity);
  const cancelRunningQuery = useQueryStore((s) => s.cancelRunningQuery);
  const terminateSession = useQueryStore((s) => s.terminateSession);

  // Auto-refresh interval (null = disabled)
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number | null>(null);

  // Refresh on mount and when profile changes
  useEffect(() => {
    if (profileId) {
      refreshActivity(profileId);
    }
  }, [profileId, refreshActivity]);

  // Auto-refresh timer
  useEffect(() => {
    if (!autoRefreshInterval || !profileId) return;

    const timer = setInterval(() => {
      refreshActivity(profileId);
    }, autoRefreshInterval * 1000);

    return () => clearInterval(timer);
  }, [autoRefreshInterval, profileId, refreshActivity]);

  // Handle manual refresh
  const handleRefresh = useCallback(() => {
    if (profileId) {
      refreshActivity(profileId);
    }
  }, [profileId, refreshActivity]);

  // Handle cancel query
  const handleCancelQuery = useCallback(
    async (pid: number) => {
      if (profileId) {
        await cancelRunningQuery(profileId, pid);
      }
    },
    [profileId, cancelRunningQuery]
  );

  // Handle terminate session
  const handleTerminateSession = useCallback(
    async (pid: number) => {
      if (profileId && confirm(t("stats.terminateConfirm"))) {
        await terminateSession(profileId, pid);
      }
    },
    [profileId, terminateSession]
  );

  // Format duration
  const formatDuration = useCallback((secs: number | null) => {
    if (secs === null) return "-";
    if (secs < 1) return t("stats.values.lessThanSecond");
    if (secs < 60) return t("stats.values.seconds", { secs: Math.round(secs) });
    if (secs < 3600) return t("stats.values.minutesSeconds", { minutes: Math.floor(secs / 60), seconds: Math.round(secs % 60) });
    return t("stats.values.hoursMinutes", { hours: Math.floor(secs / 3600), minutes: Math.floor((secs % 3600) / 60) });
  }, [t]);

  // Render empty state if no profile
  if (!profileId) {
    return (
      <div className={`h-full ${emptyStateContainer}`}>
        <Database className={`${iconXl} ${textMuted} mb-4`} />
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>{t("stats.noProfileHeading")}</p>
          <p className={emptyStateDescription}>
            {t("stats.noProfileDescription")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with refresh controls */}
      <div className={`flex items-center justify-between px-4 py-2 ${borderDivider}`}>
        <div>
          <h2 className={`text-sm font-semibold ${textPrimary}`}>{t("stats.title")}</h2>
          <p className={`text-xs ${textSecondary}`}>
            {t("stats.queries", { count: activity.queries.length })}
            {t("stats.summarySeparator")}
            {t("stats.sessions", { count: activity.sessions.length })}
            {activity.lastRefresh && (
              <span className={textMuted}>
                {t("stats.lastRefreshed", { time: new Date(activity.lastRefresh).toLocaleTimeString() })}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Auto-refresh selector */}
          <Select
            value={autoRefreshInterval ?? ""}
            onChange={(e) =>
              setAutoRefreshInterval(e.target.value ? parseInt(e.target.value) : null)
            }
            size="sm"
            className="w-auto"
          >
            <option value="">{t("stats.manual")}</option>
            <option value="5">5s</option>
            <option value="10">10s</option>
            <option value="30">30s</option>
          </Select>
          {/* Refresh button */}
          <Button
            onClick={handleRefresh}
            disabled={activity.isLoading}
            title={t("stats.refreshTooltip")}
          >
            <RefreshCw className={`${iconSm} ${activity.isLoading ? "animate-spin" : ""}`} />
            <span>{t("stats.refresh")}</span>
          </Button>
        </div>
      </div>

      {/* Error message */}
      {activity.error && (
        <div className={`px-4 py-2 ${textDanger} text-xs flex items-center gap-2`}>
          <AlertTriangle className={iconSm} />
          {activity.error}
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {/* Running Queries Section */}
        <section>
          <h3 className={`text-sm font-medium ${textPrimary} mb-2 flex items-center gap-2`}>
            <Activity className={iconSm} />
            {t("stats.runningQueries")}
          </h3>
          {activity.queries.length === 0 ? (
            <div className={`text-xs ${textMuted} p-4 text-center ${bgSurface} rounded`}>
              {t("stats.noRunning")}
            </div>
          ) : (
            <Card padding="none" className="overflow-hidden">
              <Table hover>
                <thead>
                  <tr>
                    <th>{t("stats.headers.pid")}</th>
                    <th>{t("stats.headers.user")}</th>
                    <th>{t("stats.headers.duration")}</th>
                    <th>{t("stats.headers.query")}</th>
                    <th className="text-right">{t("stats.headers.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.queries.map((query) => (
                    <QueryRow
                      key={query.pid}
                      query={query}
                      onCancel={handleCancelQuery}
                      formatDuration={formatDuration}
                    />
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </section>

        {/* Active Sessions Section */}
        <section>
          <h3 className={`text-sm font-medium ${textPrimary} mb-2 flex items-center gap-2`}>
            <User className={iconSm} />
            {t("stats.connectedSessions")}
          </h3>
          {activity.sessions.length === 0 ? (
            <div className={`text-xs ${textMuted} p-4 text-center ${bgSurface} rounded`}>
              {t("stats.noSessions")}
            </div>
          ) : (
            <Card padding="none" className="overflow-hidden">
              <Table hover>
                <thead>
                  <tr>
                    <th>{t("stats.headers.pid")}</th>
                    <th>{t("stats.headers.user")}</th>
                    <th>{t("stats.headers.application")}</th>
                    <th>{t("stats.headers.state")}</th>
                    <th>{t("stats.headers.client")}</th>
                    <th className="text-right">{t("stats.headers.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.sessions.map((session) => (
                    <SessionRow
                      key={session.pid}
                      session={session}
                      onTerminate={handleTerminateSession}
                    />
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}

// Query row component
interface QueryRowProps {
  query: DatabaseActivity;
  onCancel: (pid: number) => void;
  formatDuration: (secs: number | null) => string;
}

function QueryRow({ query, onCancel, formatDuration }: QueryRowProps) {
  const { t } = useTranslation("query");
  const [isCancelling, setIsCancelling] = useState(false);

  const handleCancel = async () => {
    setIsCancelling(true);
    try {
      await onCancel(query.pid);
    } finally {
      setIsCancelling(false);
    }
  };

  const isLongRunning = (query.duration_secs ?? 0) > 30;

  return (
    <tr>
      <td className="font-mono">{query.pid}</td>
      <td className={textSecondary}>{query.username ?? "-"}</td>
      <td className={isLongRunning ? textDataAmber : textDataGreen}>
        <span className="flex items-center gap-1">
          <Clock className={iconSm} />
          {formatDuration(query.duration_secs)}
        </span>
      </td>
      <td className={`font-mono ${textMuted} max-w-xs truncate`} title={query.query ?? ""}>
        {query.query ?? "-"}
      </td>
      <td className="text-right">
        {query.is_cancellable && (
          <IconButton
            onClick={handleCancel}
            disabled={isCancelling}
            variant="surface"
            tone="danger"
            title={t("stats.cancelQuery")}
          >
            {isCancelling ? (
              <Loader2 className={`${iconMd} animate-spin`} />
            ) : (
              <XCircle className={iconMd} />
            )}
          </IconButton>
        )}
      </td>
    </tr>
  );
}

// Session row component
interface SessionRowProps {
  session: DatabaseActivity;
  onTerminate: (pid: number) => void;
}

function SessionRow({ session, onTerminate }: SessionRowProps) {
  const { t } = useTranslation("query");
  const [isTerminating, setIsTerminating] = useState(false);

  const handleTerminate = async () => {
    setIsTerminating(true);
    try {
      await onTerminate(session.pid);
    } finally {
      setIsTerminating(false);
    }
  };

  // State colour
  const stateColour =
    session.state === "idle"
      ? textDataGreen
      : session.state === "idle in transaction"
        ? textDataAmber
        : textSecondary;

  return (
    <tr>
      <td className="font-mono">{session.pid}</td>
      <td className={textSecondary}>{session.username ?? "-"}</td>
      <td className={textMuted}>
        <span className="flex items-center gap-1">
          <Terminal className={iconSm} />
          {session.application_name || "-"}
        </span>
      </td>
      <td className={stateColour}>{session.state ?? "-"}</td>
      <td className={`font-mono ${textMuted}`}>{session.client_addr ?? t("stats.values.local")}</td>
      <td className="text-right">
        <IconButton
          onClick={handleTerminate}
          disabled={isTerminating}
          variant="surface"
          tone="danger"
          className="opacity-50 hover:opacity-100"
          title={t("stats.terminateSession")}
        >
          {isTerminating ? (
            <Loader2 className={`${iconMd} animate-spin`} />
          ) : (
            <XCircle className={iconMd} />
          )}
        </IconButton>
      </td>
    </tr>
  );
}

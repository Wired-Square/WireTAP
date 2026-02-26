// src/apps/query/views/StatsPanel.tsx
//
// Stats panel showing database activity: running queries and active sessions.
// Allows cancelling queries and terminating sessions.

import { useCallback, useEffect, useState } from "react";
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
import { buttonBase, iconButtonBase } from "../../../styles/buttonStyles";
import { monoBody, emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from "../../../styles/typography";
import { iconSm, iconMd, iconXl } from "../../../styles/spacing";
import {
  borderDivider,
  hoverBg,
  textPrimary,
  textSecondary,
  textMuted,
  textDataGreen,
  textDataAmber,
  textDanger,
  bgSurface,
} from "../../../styles/colourTokens";

interface Props {
  profileId: string | null;
}

export default function StatsPanel({ profileId }: Props) {
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
      if (profileId && confirm("Terminate this session? This will close the connection.")) {
        await terminateSession(profileId, pid);
      }
    },
    [profileId, terminateSession]
  );

  // Format duration
  const formatDuration = useCallback((secs: number | null) => {
    if (secs === null) return "-";
    if (secs < 1) return "<1s";
    if (secs < 60) return `${Math.round(secs)}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
    return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  }, []);

  // Render empty state if no profile
  if (!profileId) {
    return (
      <div className={`h-full ${emptyStateContainer}`}>
        <Database className={`${iconXl} ${textMuted} mb-4`} />
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>No Database Selected</p>
          <p className={emptyStateDescription}>
            Select a PostgreSQL profile to view database activity.
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
          <h2 className={`text-sm font-semibold ${textPrimary}`}>Database Activity</h2>
          <p className={`text-xs ${textSecondary}`}>
            {activity.queries.length} running {activity.queries.length === 1 ? "query" : "queries"}
            {" · "}
            {activity.sessions.length} {activity.sessions.length === 1 ? "session" : "sessions"}
            {activity.lastRefresh && (
              <span className={textMuted}>
                {" · "}Last refreshed {new Date(activity.lastRefresh).toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Auto-refresh selector */}
          <select
            value={autoRefreshInterval ?? ""}
            onChange={(e) =>
              setAutoRefreshInterval(e.target.value ? parseInt(e.target.value) : null)
            }
            className={`text-xs px-2 py-1 rounded border border-[var(--border-default)] ${bgSurface} ${textPrimary}`}
          >
            <option value="">Manual</option>
            <option value="5">5s</option>
            <option value="10">10s</option>
            <option value="30">30s</option>
          </select>
          {/* Refresh button */}
          <button
            onClick={handleRefresh}
            disabled={activity.isLoading}
            className={buttonBase}
            title="Refresh activity"
          >
            <RefreshCw className={`${iconSm} ${activity.isLoading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
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
            Running Queries
          </h3>
          {activity.queries.length === 0 ? (
            <div className={`text-xs ${textMuted} p-4 text-center ${bgSurface} rounded`}>
              No active queries running
            </div>
          ) : (
            <div className={`border border-[var(--border-default)] rounded overflow-hidden`}>
              <table className="w-full text-xs">
                <thead className={`${bgSurface} ${textSecondary}`}>
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">PID</th>
                    <th className="px-3 py-2 text-left font-medium">User</th>
                    <th className="px-3 py-2 text-left font-medium">Duration</th>
                    <th className="px-3 py-2 text-left font-medium">Query</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-default)]">
                  {activity.queries.map((query) => (
                    <QueryRow
                      key={query.pid}
                      query={query}
                      onCancel={handleCancelQuery}
                      formatDuration={formatDuration}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Active Sessions Section */}
        <section>
          <h3 className={`text-sm font-medium ${textPrimary} mb-2 flex items-center gap-2`}>
            <User className={iconSm} />
            Connected Sessions
          </h3>
          {activity.sessions.length === 0 ? (
            <div className={`text-xs ${textMuted} p-4 text-center ${bgSurface} rounded`}>
              No other sessions connected
            </div>
          ) : (
            <div className={`border border-[var(--border-default)] rounded overflow-hidden`}>
              <table className="w-full text-xs">
                <thead className={`${bgSurface} ${textSecondary}`}>
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">PID</th>
                    <th className="px-3 py-2 text-left font-medium">User</th>
                    <th className="px-3 py-2 text-left font-medium">Application</th>
                    <th className="px-3 py-2 text-left font-medium">State</th>
                    <th className="px-3 py-2 text-left font-medium">Client</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-default)]">
                  {activity.sessions.map((session) => (
                    <SessionRow
                      key={session.pid}
                      session={session}
                      onTerminate={handleTerminateSession}
                    />
                  ))}
                </tbody>
              </table>
            </div>
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
    <tr className={hoverBg}>
      <td className={`px-3 py-2 ${monoBody} ${textPrimary}`}>{query.pid}</td>
      <td className={`px-3 py-2 ${textSecondary}`}>{query.username ?? "-"}</td>
      <td className={`px-3 py-2 ${isLongRunning ? textDataAmber : textDataGreen}`}>
        <span className="flex items-center gap-1">
          <Clock className={iconSm} />
          {formatDuration(query.duration_secs)}
        </span>
      </td>
      <td className={`px-3 py-2 ${monoBody} ${textMuted} max-w-xs truncate`} title={query.query ?? ""}>
        {query.query ?? "-"}
      </td>
      <td className="px-3 py-2 text-right">
        {query.is_cancellable && (
          <button
            onClick={handleCancel}
            disabled={isCancelling}
            className={`${iconButtonBase} ${textDanger}`}
            title="Cancel query"
          >
            {isCancelling ? (
              <Loader2 className={`${iconMd} animate-spin`} />
            ) : (
              <XCircle className={iconMd} />
            )}
          </button>
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
    <tr className={hoverBg}>
      <td className={`px-3 py-2 ${monoBody} ${textPrimary}`}>{session.pid}</td>
      <td className={`px-3 py-2 ${textSecondary}`}>{session.username ?? "-"}</td>
      <td className={`px-3 py-2 ${textMuted}`}>
        <span className="flex items-center gap-1">
          <Terminal className={iconSm} />
          {session.application_name || "-"}
        </span>
      </td>
      <td className={`px-3 py-2 ${stateColour}`}>{session.state ?? "-"}</td>
      <td className={`px-3 py-2 ${monoBody} ${textMuted}`}>{session.client_addr ?? "local"}</td>
      <td className="px-3 py-2 text-right">
        <button
          onClick={handleTerminate}
          disabled={isTerminating}
          className={`${iconButtonBase} ${textDanger} opacity-50 hover:opacity-100`}
          title="Terminate session"
        >
          {isTerminating ? (
            <Loader2 className={`${iconMd} animate-spin`} />
          ) : (
            <XCircle className={iconMd} />
          )}
        </button>
      </td>
    </tr>
  );
}

// src/apps/session-manager/views/SessionLogView.tsx
//
// Log view component showing session events for development debugging.
// Features filter bar, scrollable table, and auto-scroll.

import { useEffect, useRef, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Trash2,
  Filter,
  Search,
  ChevronDown,
  ArrowDownToLine,
  User,
  Copy,
  Check,
} from "lucide-react";
import {
  useSessionLogStore,
  useFilteredEntries,
  useUniqueSessionIds,
  describeEntry,
  displayKind,
  profileNames,
  KIND_LABELS,
  KIND_BADGE,
  KIND_GROUPS,
  ALL_KINDS,
  type SessionLogKind,
} from "../stores/sessionLogStore";
import { clearSessionLog } from "../../../api/io";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import {
  textSecondary,
  textMuted,
  bgSurface,
  bgDataView,
  borderDefault,
  emptyStateContainer,
  emptyStateText,
  emptyStateHeading,
  emptyStateDescription,
} from "../../../styles";
import { COPY_FEEDBACK_TIMEOUT_MS } from "../../../constants";
import { Button, IconButton } from "../../../components/Button";
import { Popover, usePopover } from "../../../components/Menu";
import { Badge } from "../../../components/Badge";
import { Input, Select } from "../../../components/forms";
import { Table } from "../../../components/Table";

/** Format timestamp as HH:MM:SS.mmm */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  const millis = date.getMilliseconds().toString().padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

/** Truncate session ID for display */
function truncateSessionId(sessionId: string | null, maxLen = 16): string {
  if (!sessionId) return "-";
  if (sessionId.length <= maxLen) return sessionId;
  return sessionId.slice(0, maxLen - 3) + "...";
}

export default function SessionLogView() {
  const { t } = useTranslation("sessionManager");
  const entries = useFilteredEntries();
  const uniqueSessionIds = useUniqueSessionIds();
  const filter = useSessionLogStore((s) => s.filter);
  const eventFilter = usePopover("dialog");
  const autoScroll = useSessionLogStore((s) => s.autoScroll);
  const showProfileColumn = useSessionLogStore((s) => s.showProfileColumn);
  const setFilter = useSessionLogStore((s) => s.setFilter);
  const setAutoScroll = useSessionLogStore((s) => s.setAutoScroll);
  const setShowProfileColumn = useSessionLogStore((s) => s.setShowProfileColumn);
  const profiles = useSettingsStore((s) => s.ioProfiles.profiles);
  const totalCount = useSessionLogStore((s) => s.entries.length);

  // Copy state
  const [copied, setCopied] = useState(false);

  // Copy log entries to clipboard
  const handleCopy = useCallback(async () => {
    const lines = entries.map((entry) => {
      const time = formatTime(entry.timestamp_ms);
      const event = KIND_LABELS[displayKind(entry.event)];
      const session = entry.session_id ?? "-";
      const profile = profileNames(entry, profiles) ?? "-";
      return `${time}\t${event}\t${session}\t${profile}\t${describeEntry(entry)}`;
    });
    const header = "Time\tEvent\tSession\tProfile\tDetails";
    const text = [header, ...lines].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_TIMEOUT_MS);
    } catch (e) {
      console.error("Failed to copy log:", e);
    }
  }, [entries, profiles]);

  // Auto-scroll to bottom when new entries arrive
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevEntriesLengthRef = useRef(entries.length);

  useEffect(() => {
    if (autoScroll && entries.length > prevEntriesLengthRef.current) {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
    prevEntriesLengthRef.current = entries.length;
  }, [entries.length, autoScroll]);

  // Handle scroll to detect manual scrolling (pause auto-scroll)
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    if (!isAtBottom && autoScroll) {
      setAutoScroll(false);
    }
  }, [autoScroll, setAutoScroll]);

  const toggleKind = useCallback(
    (kind: SessionLogKind) => {
      const kinds = new Set(filter.kinds ?? ALL_KINDS);
      if (kinds.has(kind)) kinds.delete(kind);
      else kinds.add(kind);
      setFilter({ kinds: kinds.size === 0 || kinds.size === ALL_KINDS.length ? null : kinds });
    },
    [filter.kinds, setFilter]
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Filter Bar */}
      <div
        className={`flex items-center gap-3 px-3 py-2 border-b ${borderDefault} ${bgSurface}`}
      >
        {/* Event type filter */}
        <Button {...eventFilter.trigger} variant="outline" size="sm">
          <Filter className="w-3 h-3" />
          <span>{t("log.filter.events")}</span>
          {filter.kinds && (
            <Badge tone="primary" size="sm">{filter.kinds.size}</Badge>
          )}
          <ChevronDown className="w-3 h-3" />
        </Button>
        <Popover {...eventFilter.popover} className="p-2 min-w-50">
          {KIND_GROUPS.map((group) => (
            <div key={group.key} className="mb-2 last:mb-0">
              <div className={`text-2xs uppercase font-medium ${textMuted} mb-1`}>
                {t(`log.filter.groups.${group.key}`)}
              </div>
              <div className="flex flex-wrap gap-1">
                {group.kinds.map((kind) => (
                  <Button
                    key={kind}
                    variant="outline"
                    tone={KIND_BADGE[kind].tone}
                    size="xs"
                    pressed={!filter.kinds || filter.kinds.has(kind)}
                    onClick={() => toggleKind(kind)}
                  >
                    {KIND_LABELS[kind]}
                  </Button>
                ))}
              </div>
            </div>
          ))}
          <Button
            onClick={() => setFilter({ kinds: null })}
            variant="outline"
            size="sm"
            className="w-full mt-2"
          >
            {t("log.filter.showAll")}
          </Button>
        </Popover>

        {/* Session Filter */}
        <Select
          value={filter.sessionId ?? ""}
          onChange={(e) =>
            setFilter({ sessionId: e.target.value || null })
          }
          size="sm"
          className="w-auto"
        >
          <option value="">{t("log.allSessions")}</option>
          {uniqueSessionIds.map((sessionId) => (
            <option key={sessionId} value={sessionId}>
              {truncateSessionId(sessionId, 24)}
            </option>
          ))}
        </Select>

        {/* Search Input */}
        <div className="relative flex-1 max-w-50">
          <Search className={`absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 ${textMuted}`} />
          <Input
            type="text"
            placeholder={t("log.search")}
            value={filter.searchText}
            onChange={(e) => setFilter({ searchText: e.target.value })}
            size="sm"
            className="pl-7"
          />
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Profile Column Toggle */}
        <IconButton
          onClick={() => setShowProfileColumn(!showProfileColumn)}
          size="sm"
          pressed={showProfileColumn}
          title={showProfileColumn ? t("log.hideProfileColumn") : t("log.showProfileColumn")}
        >
          <User className="w-4 h-4" />
        </IconButton>

        {/* Entry Count */}
        <span className={`text-xs ${textMuted}`}>
          {entries.length === totalCount
            ? t("log.entries", { count: totalCount })
            : t("log.entriesFiltered", {
                count: totalCount,
                filtered: entries.length,
                total: totalCount,
              })}
        </span>

        {/* Auto-scroll Toggle */}
        <IconButton
          onClick={() => {
            setAutoScroll(true);
            scrollRef.current?.scrollTo({
              top: scrollRef.current.scrollHeight,
              behavior: "smooth",
            });
          }}
          size="sm"
          pressed={autoScroll}
          title={t("log.scrollToBottom")}
        >
          <ArrowDownToLine className="w-4 h-4" />
        </IconButton>

        {/* Copy Button */}
        <Button
          onClick={handleCopy}
          tone={copied ? "success" : "neutral"}
          size="sm"
          title={t("log.copyLog")}
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </Button>

        {/* Clear Button */}
        <IconButton
          onClick={() => void clearSessionLog()}
          tone="danger"
          size="sm"
          title={t("log.clearLog")}
        >
          <Trash2 className="w-4 h-4" />
        </IconButton>
      </div>

      {/* Log Table */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={`flex-1 overflow-auto pb-4 ${bgDataView}`}
      >
        {entries.length === 0 ? (
          <div className={emptyStateContainer}>
            <div className={emptyStateText}>
              <p className={emptyStateHeading}>{t("log.empty.heading")}</p>
              <p className={emptyStateDescription}>{t("log.empty.description")}</p>
            </div>
          </div>
        ) : (
          <Table sticky hover>
            <thead>
              <tr>
                <th className="w-25">{t("log.headers.time")}</th>
                <th className="w-22.5">{t("log.headers.event")}</th>
                <th className="w-30">{t("log.headers.session")}</th>
                {showProfileColumn && <th className="w-35">{t("log.headers.profile")}</th>}
                <th>{t("log.headers.details")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const kind = displayKind(entry.event);
                const profileName = profileNames(entry, profiles);
                return (
                  <tr key={entry.id}>
                    <td className={`font-mono ${textMuted}`}>
                      {formatTime(entry.timestamp_ms)}
                    </td>
                    <td>
                      <Badge size="sm" {...KIND_BADGE[kind]}>
                        {KIND_LABELS[kind]}
                      </Badge>
                    </td>
                    <td
                      className={`font-mono ${textSecondary}`}
                      title={profileName ? t("log.profileTitle", { name: profileName }) : undefined}
                    >
                      {truncateSessionId(entry.session_id)}
                    </td>
                    {showProfileColumn && (
                      <td className={textSecondary}>
                        <span className="max-w-32.5 truncate block">
                          {profileName ?? "-"}
                        </span>
                      </td>
                    )}
                    <td>{describeEntry(entry)}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>
    </div>
  );
}

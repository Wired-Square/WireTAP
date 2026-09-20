// src/apps/session-manager/views/SessionLogView.tsx
//
// Log view component showing session events for development debugging.
// Features filter bar, scrollable table, and auto-scroll.

import { useEffect, useRef, useMemo, useCallback, useState } from "react";
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
  EVENT_TYPE_LABELS,
  EVENT_TYPE_BADGE,
  ALL_EVENT_TYPES,
  type SessionLogEventType,
} from "../stores/sessionLogStore";
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
  const clearEntries = useSessionLogStore((s) => s.clearEntries);
  const totalCount = useSessionLogStore((s) => s.entries.length);

  // Copy state
  const [copied, setCopied] = useState(false);

  // Copy log entries to clipboard
  const handleCopy = useCallback(async () => {
    const lines = entries.map((entry) => {
      const time = formatTime(entry.timestamp);
      const event = EVENT_TYPE_LABELS[entry.eventType];
      const session = entry.sessionId ?? "-";
      const profile = entry.profileName ?? "-";
      const details = entry.details;
      return `${time}\t${event}\t${session}\t${profile}\t${details}`;
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
  }, [entries]);

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

  // Event type filter toggle
  const toggleEventType = useCallback(
    (eventType: SessionLogEventType) => {
      const currentTypes = filter.eventTypes;
      if (!currentTypes) {
        // Currently showing all, create set with all except this one
        const newSet = new Set(ALL_EVENT_TYPES);
        newSet.delete(eventType);
        setFilter({ eventTypes: newSet });
      } else if (currentTypes.has(eventType)) {
        // Remove from set
        const newSet = new Set(currentTypes);
        newSet.delete(eventType);
        setFilter({ eventTypes: newSet.size === 0 ? null : newSet });
      } else {
        // Add to set
        const newSet = new Set(currentTypes);
        newSet.add(eventType);
        // If all types selected, set to null (show all)
        if (newSet.size === ALL_EVENT_TYPES.length) {
          setFilter({ eventTypes: null });
        } else {
          setFilter({ eventTypes: newSet });
        }
      }
    },
    [filter.eventTypes, setFilter]
  );

  // Check if event type is active in filter
  const isEventTypeActive = useCallback(
    (eventType: SessionLogEventType): boolean => {
      if (!filter.eventTypes) return true;
      return filter.eventTypes.has(eventType);
    },
    [filter.eventTypes]
  );

  // Grouped event types for the filter dropdown
  const eventTypeGroups = useMemo(
    () => [
      {
        label: t("log.filter.groups.lifecycle"),
        types: [
          "session-created",
          "session-joined",
          "session-left",
          "session-destroyed",
        ] as SessionLogEventType[],
      },
      {
        label: t("log.filter.groups.stream"),
        types: [
          "state-change",
          "stream-ended",
          "stream-complete",
          "session-error",
          "speed-changed",
          "session-mode",
        ] as SessionLogEventType[],
      },
      {
        label: t("log.filter.groups.status"),
        types: [
          "session-reconfigured",
          "session-stats",
          "buffer-orphaned",
          "buffer-created",
          "device-connected",
          "device-probe",
        ] as SessionLogEventType[],
      },
    ],
    [t]
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
          {filter.eventTypes && (
            <Badge tone="primary" size="sm">{filter.eventTypes.size}</Badge>
          )}
          <ChevronDown className="w-3 h-3" />
        </Button>
        <Popover {...eventFilter.popover} className="p-2 min-w-50">
          {eventTypeGroups.map((group) => (
            <div key={group.label} className="mb-2 last:mb-0">
              <div className={`text-2xs uppercase font-medium ${textMuted} mb-1`}>
                {group.label}
              </div>
              <div className="flex flex-wrap gap-1">
                {group.types.map((eventType) => (
                  <Button
                    key={eventType}
                    variant="outline"
                    tone={EVENT_TYPE_BADGE[eventType].tone}
                    size="xs"
                    pressed={isEventTypeActive(eventType)}
                    onClick={() => toggleEventType(eventType)}
                  >
                    {EVENT_TYPE_LABELS[eventType]}
                  </Button>
                ))}
              </div>
            </div>
          ))}
          <Button
            onClick={() => setFilter({ eventTypes: null })}
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
          onClick={clearEntries}
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
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className={`font-mono ${textMuted}`}>
                    {formatTime(entry.timestamp)}
                  </td>
                  <td>
                    <Badge size="sm" {...EVENT_TYPE_BADGE[entry.eventType]}>
                      {EVENT_TYPE_LABELS[entry.eventType]}
                    </Badge>
                  </td>
                  <td
                    className={`font-mono ${textSecondary}`}
                    title={entry.profileName ? t("log.profileTitle", { name: entry.profileName }) : undefined}
                  >
                    {truncateSessionId(entry.sessionId)}
                  </td>
                  {showProfileColumn && (
                    <td className={textSecondary}>
                      <span className="max-w-32.5 truncate block">
                        {entry.profileName ?? "-"}
                      </span>
                    </td>
                  )}
                  <td>{entry.details}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </div>
  );
}

// src/apps/session-manager/views/SessionLogView.tsx
//
// Log view component showing session events for development debugging.
// Features filter bar, scrollable table, and auto-scroll.

import { useEffect, useRef, useMemo, useCallback, useState } from "react";
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
  EVENT_TYPE_COLOURS,
  ALL_EVENT_TYPES,
  type SessionLogEventType,
} from "../stores/sessionLogStore";
import {
  textPrimary,
  textSecondary,
  textMuted,
  bgSurface,
  bgDataView,
  borderDefault,
  hoverBg,
} from "../../../styles";
import { COPY_FEEDBACK_TIMEOUT_MS } from "../../../constants";

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
  const entries = useFilteredEntries();
  const uniqueSessionIds = useUniqueSessionIds();
  const filter = useSessionLogStore((s) => s.filter);
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
        label: "Lifecycle",
        types: [
          "session-created",
          "session-joined",
          "session-left",
          "session-destroyed",
        ] as SessionLogEventType[],
      },
      {
        label: "Stream",
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
        label: "Status",
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
    []
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Filter Bar */}
      <div
        className={`flex items-center gap-3 px-3 py-2 border-b ${borderDefault} ${bgSurface}`}
      >
        {/* Event Type Filter Dropdown */}
        <div className="relative group">
          <button
            className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded border ${borderDefault} ${bgSurface} ${textSecondary} ${hoverBg}`}
          >
            <Filter className="w-3 h-3" />
            <span>Events</span>
            {filter.eventTypes && (
              <span className="px-1 bg-blue-500/20 text-blue-400 rounded text-[10px]">
                {filter.eventTypes.size}
              </span>
            )}
            <ChevronDown className="w-3 h-3" />
          </button>
          {/* Dropdown */}
          <div
            className={`absolute left-0 top-full mt-1 z-50 p-2 rounded-lg border ${borderDefault} ${bgSurface} shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-opacity min-w-[200px]`}
          >
            {eventTypeGroups.map((group) => (
              <div key={group.label} className="mb-2 last:mb-0">
                <div className={`text-[10px] uppercase font-medium ${textMuted} mb-1`}>
                  {group.label}
                </div>
                <div className="flex flex-wrap gap-1">
                  {group.types.map((eventType) => (
                    <button
                      key={eventType}
                      onClick={() => toggleEventType(eventType)}
                      className={`px-1.5 py-0.5 text-[10px] rounded transition-opacity ${
                        EVENT_TYPE_COLOURS[eventType]
                      } ${isEventTypeActive(eventType) ? "opacity-100" : "opacity-40"}`}
                    >
                      {EVENT_TYPE_LABELS[eventType]}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <button
              onClick={() => setFilter({ eventTypes: null })}
              className={`w-full mt-2 px-2 py-1 text-[10px] rounded border ${borderDefault} ${textSecondary} ${hoverBg}`}
            >
              Show All
            </button>
          </div>
        </div>

        {/* Session Filter */}
        <select
          value={filter.sessionId ?? ""}
          onChange={(e) =>
            setFilter({ sessionId: e.target.value || null })
          }
          className={`text-xs px-2 py-1 rounded border ${borderDefault} ${bgSurface} ${textSecondary} focus:outline-none`}
        >
          <option value="">All sessions</option>
          {uniqueSessionIds.map((sessionId) => (
            <option key={sessionId} value={sessionId}>
              {truncateSessionId(sessionId, 24)}
            </option>
          ))}
        </select>

        {/* Search Input */}
        <div className="relative flex-1 max-w-[200px]">
          <Search className={`absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 ${textMuted}`} />
          <input
            type="text"
            placeholder="Search..."
            value={filter.searchText}
            onChange={(e) => setFilter({ searchText: e.target.value })}
            className={`w-full text-xs pl-7 pr-2 py-1 rounded border ${borderDefault} ${bgSurface} ${textPrimary} placeholder:${textMuted} focus:outline-none focus:ring-1 focus:ring-blue-500`}
          />
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Profile Column Toggle */}
        <button
          onClick={() => setShowProfileColumn(!showProfileColumn)}
          className={`p-1 rounded ${hoverBg} ${
            showProfileColumn ? "text-blue-400" : textMuted
          }`}
          title={showProfileColumn ? "Hide profile column" : "Show profile column"}
        >
          <User className="w-4 h-4" />
        </button>

        {/* Entry Count */}
        <span className={`text-xs ${textMuted}`}>
          {entries.length === totalCount
            ? `${totalCount} entries`
            : `${entries.length} / ${totalCount} entries`}
        </span>

        {/* Auto-scroll Toggle */}
        <button
          onClick={() => {
            setAutoScroll(true);
            scrollRef.current?.scrollTo({
              top: scrollRef.current.scrollHeight,
              behavior: "smooth",
            });
          }}
          className={`p-1 rounded ${hoverBg} ${
            autoScroll ? "text-blue-400" : textMuted
          }`}
          title="Scroll to bottom"
        >
          <ArrowDownToLine className="w-4 h-4" />
        </button>

        {/* Copy Button */}
        <button
          onClick={handleCopy}
          className={`p-1 rounded ${hoverBg} ${copied ? "text-green-400" : textMuted}`}
          title="Copy log to clipboard"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>

        {/* Clear Button */}
        <button
          onClick={clearEntries}
          className={`p-1 rounded ${hoverBg} ${textMuted} hover:text-red-400`}
          title="Clear log"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Log Table */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={`flex-1 overflow-auto pb-4 ${bgDataView}`}
      >
        {entries.length === 0 ? (
          <div className={`flex items-center justify-center h-full ${textMuted}`}>
            <div className="text-center">
              <p className="text-sm">No log entries</p>
              <p className="text-xs mt-1">Session events will appear here</p>
            </div>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className={`sticky top-0 ${bgSurface}`}>
              <tr className={`border-b ${borderDefault}`}>
                <th className={`px-2 py-1.5 text-left font-medium ${textMuted} w-[100px]`}>
                  Time
                </th>
                <th className={`px-2 py-1.5 text-left font-medium ${textMuted} w-[90px]`}>
                  Event
                </th>
                <th className={`px-2 py-1.5 text-left font-medium ${textMuted} w-[120px]`}>
                  Session
                </th>
                {showProfileColumn && (
                  <th className={`px-2 py-1.5 text-left font-medium ${textMuted} w-[140px]`}>
                    Profile
                  </th>
                )}
                <th className={`px-2 py-1.5 text-left font-medium ${textMuted}`}>
                  Details
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.id}
                  className={`border-b border-[color:var(--border-default)]/30 ${hoverBg}`}
                >
                  <td className={`px-2 py-1 font-mono ${textMuted}`}>
                    {formatTime(entry.timestamp)}
                  </td>
                  <td className="px-2 py-1">
                    <span className={EVENT_TYPE_COLOURS[entry.eventType]}>
                      {EVENT_TYPE_LABELS[entry.eventType]}
                    </span>
                  </td>
                  <td
                    className={`px-2 py-1 font-mono ${textSecondary} cursor-default`}
                    title={entry.profileName ? `Profile: ${entry.profileName}` : undefined}
                  >
                    {truncateSessionId(entry.sessionId)}
                  </td>
                  {showProfileColumn && (
                    <td className={`px-2 py-1 ${textSecondary}`}>
                      <span className="max-w-[130px] truncate block">
                        {entry.profileName ?? "-"}
                      </span>
                    </td>
                  )}
                  <td className={`px-2 py-1 ${textPrimary}`}>
                    {entry.details}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

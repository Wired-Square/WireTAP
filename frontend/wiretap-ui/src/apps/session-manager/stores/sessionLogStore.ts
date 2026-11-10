// src/apps/session-manager/stores/sessionLogStore.ts
//
// This window's copy of the Rust session log ring, plus the log view's UI state.

import i18n from "i18next";
import { create } from "@wired-square/store/react";
import type { BadgeStyleProps } from "../../../components/Badge";
import type { SessionLogEntry } from "../../../generated/SessionLogEntry";
import type { SessionLogEvent } from "../../../generated/SessionLogEvent";
import type { IOState } from "../../../generated/IOState";
import type { SessionMode } from "../../../generated/SessionMode";
import type { IOProfile } from "../../../hooks/useSettings";
import { SESSION_LOG_CAPACITY } from "../../../generated/wireConstants";
import { getStateType } from "../../../api/io";
import { appNodeLabel } from "../utils/appNodeLabel";

export type { SessionLogEntry };
export type SessionLogKind = SessionLogEvent["kind"];

export interface LogFilter {
  /** null shows every kind */
  kinds: Set<SessionLogKind> | null;
  sessionId: string | null;
  searchText: string;
}

export interface SessionLogState {
  entries: SessionLogEntry[];
  filter: LogFilter;
  autoScroll: boolean;
  showProfileColumn: boolean;

  ingest: (entries: SessionLogEntry[]) => void;
  setFilter: (filter: Partial<LogFilter>) => void;
  setAutoScroll: (enabled: boolean) => void;
  setShowProfileColumn: (show: boolean) => void;
}

export function lastEntryId(entries: SessionLogEntry[]): number | undefined {
  return entries[entries.length - 1]?.id;
}

/** Append what Rust sent after what this window holds; a `cleared` entry drops everything before it. */
function merge(held: SessionLogEntry[], incoming: SessionLogEntry[]): SessionLogEntry[] {
  const after = lastEntryId(held) ?? 0;
  const fresh = incoming.filter((e) => e.id > after);
  if (fresh.length === 0) return held;
  let merged = [...held, ...fresh];
  for (let i = merged.length - 1; i > 0; i--) {
    if (merged[i].event.kind === "cleared") {
      merged = merged.slice(i);
      break;
    }
  }
  return merged.length > SESSION_LOG_CAPACITY ? merged.slice(-SESSION_LOG_CAPACITY) : merged;
}

export const useSessionLogStore = create<SessionLogState>((set) => ({
  entries: [],
  filter: { kinds: null, sessionId: null, searchText: "" },
  autoScroll: true,
  showProfileColumn: true,

  ingest: (incoming) =>
    set((state) => {
      const entries = merge(state.entries, incoming);
      return entries === state.entries ? state : { entries };
    }),

  setFilter: (filterUpdate) => set((state) => ({ filter: { ...state.filter, ...filterUpdate } })),
  setAutoScroll: (enabled) => set({ autoScroll: enabled }),
  setShowProfileColumn: (show) => set({ showProfileColumn: show }),
}));

// ============================================================================
// Rendering
// ============================================================================

const EVENTS = "sessionManager:log.events";

const modeLabel = (mode: SessionMode) => i18n.t(`${EVENTS}.modes.${mode}`);

/** A session's state as text; its id stays the logic and colour key. */
export const ioStateLabel = (state: IOState) => i18n.t(`sessionManager:ioStates.${getStateType(state)}`);

function stateLabel(state: IOState): string {
  return state.type === "Error" ? i18n.t("sessionManager:ioStates.errorWithMessage", { message: state.message }) : ioStateLabel(state);
}

const listeners = (count: number) => i18n.t(`${EVENTS}.listeners`, { count });

/** The kinds the badge and filter treat as one: a stream that ended at its end is a completion. */
export function displayKind(event: SessionLogEvent): SessionLogKind | "stream_complete" {
  return event.kind === "stream_ended" && event.reason === "paused" ? "stream_complete" : event.kind;
}

export function describeEvent(event: SessionLogEvent, who: string | null): string {
  const subject = who ?? i18n.t(`${EVENTS}.listener`);
  switch (event.kind) {
    case "created":
      return i18n.t(`${EVENTS}.created`, { mode: modeLabel(event.mode) });
    case "joined":
      return i18n.t(`${EVENTS}.joined`, { who: subject, listeners: listeners(event.subscriber_count) });
    case "left":
      return i18n.t(`${EVENTS}.left`, { who: subject, listeners: listeners(event.subscriber_count) });
    case "destroyed":
      return i18n.t(event.reset ? `${EVENTS}.destroyedReset` : `${EVENTS}.destroyed`);
    case "state":
      return i18n.t(`${EVENTS}.state`, { state: stateLabel(event.state) });
    case "transitioned":
      return i18n.t(`${EVENTS}.transitioned`, {
        transition: i18n.t(`${EVENTS}.transitions.${event.transition}`),
        mode: modeLabel(event.mode),
      });
    case "speed":
      return i18n.t(`${EVENTS}.speed`, { speed: event.speed });
    case "reconfigured":
      return i18n.t(`${EVENTS}.reconfigured`);
    case "capture_changed":
      return i18n.t(`${EVENTS}.captureChanged`);
    case "stream_ended":
      if (event.reason === "paused") return i18n.t(`${EVENTS}.streamCompleted`);
      return i18n.t(`${EVENTS}.streamEnded`, {
        reason: event.reason,
        capture: event.capture_count === null
          ? i18n.t(`${EVENTS}.noCapture`)
          : i18n.t(`${EVENTS}.captureItems`, { count: event.capture_count }),
      });
    case "error":
      return event.message;
    case "device_connected":
      return event.bus === null
        ? i18n.t(`${EVENTS}.deviceConnected`, { source: event.source_type, address: event.address })
        : i18n.t(`${EVENTS}.deviceConnectedOnBus`, { source: event.source_type, address: event.address, bus: event.bus });
    case "device_probe": {
      const outcome = event.success
        ? i18n.t(`${EVENTS}.busCount`, { count: event.bus_count })
        : (event.error ?? i18n.t(`${EVENTS}.probeFailed`));
      return i18n.t(event.cached ? `${EVENTS}.probeCached` : `${EVENTS}.probe`, {
        source: event.source_type,
        address: event.address,
        outcome,
      });
    }
    case "mcp_connected":
      return i18n.t(`${EVENTS}.mcpConnected`, { client: event.client.slice(0, 8) });
    case "mcp_disconnected":
      return i18n.t(`${EVENTS}.mcpDisconnected`, { client: event.client.slice(0, 8) });
    case "stats":
      return i18n.t(`${EVENTS}.stats`, {
        state: ioStateLabel(event.state),
        listeners: event.subscriber_count,
        frames: event.frame_count,
      });
    case "cleared":
      return i18n.t(`${EVENTS}.cleared`);
  }
}

export function describeEntry(entry: SessionLogEntry): string {
  const subject = entry.app_name ?? entry.subscriber_id;
  return describeEvent(entry.event, subject && appNodeLabel(i18n.getFixedT(null, "sessionManager"), subject, subject));
}

export function profileNames(entry: SessionLogEntry, profiles: Pick<IOProfile, "id" | "name">[]): string | null {
  if (entry.profile_ids.length === 0) return null;
  return entry.profile_ids.map((id) => profiles.find((p) => p.id === id)?.name ?? id).join(", ");
}

export function filterEntries(entries: SessionLogEntry[], filter: LogFilter): SessionLogEntry[] {
  const search = filter.searchText.toLowerCase();
  return entries.filter((entry) => {
    if (filter.kinds && !filter.kinds.has(entry.event.kind)) return false;
    if (filter.sessionId && entry.session_id !== filter.sessionId) return false;
    if (!search) return true;
    return [describeEntry(entry), entry.session_id, entry.app_name, entry.subscriber_id, ...entry.profile_ids].some(
      (text) => text?.toLowerCase().includes(search),
    );
  });
}

export function useFilteredEntries(): SessionLogEntry[] {
  const entries = useSessionLogStore((s) => s.entries);
  const filter = useSessionLogStore((s) => s.filter);
  return filterEntries(entries, filter);
}

export function useUniqueSessionIds(): string[] {
  const entries = useSessionLogStore((s) => s.entries);
  return [...new Set(entries.flatMap((e) => (e.session_id ? [e.session_id] : [])))].sort();
}

export const kindLabel = (kind: SessionLogKind | "stream_complete") => i18n.t(`sessionManager:log.kinds.${kind}`);

export const KIND_BADGE: Record<SessionLogKind | "stream_complete", BadgeStyleProps> = {
  created: { tone: "success" },
  joined: { tone: "primary" },
  left: { tone: "warning" },
  destroyed: { tone: "danger" },
  state: { tone: "primary" },
  transitioned: { tone: "purple" },
  stream_ended: { tone: "warning" },
  stream_complete: { tone: "success" },
  error: { tone: "danger" },
  speed: { tone: "primary" },
  reconfigured: { tone: "primary" },
  capture_changed: { tone: "primary" },
  stats: { variant: "outline" },
  device_connected: { tone: "success" },
  device_probe: { tone: "primary" },
  mcp_connected: { tone: "purple" },
  mcp_disconnected: {},
  cleared: { variant: "outline" },
};

/** The filter's groups; every kind but `cleared` appears in one. */
export const KIND_GROUPS: { key: "lifecycle" | "stream" | "status"; kinds: SessionLogKind[] }[] = [
  { key: "lifecycle", kinds: ["created", "joined", "left", "destroyed"] },
  { key: "stream", kinds: ["state", "transitioned", "stream_ended", "error", "speed"] },
  {
    key: "status",
    kinds: ["reconfigured", "capture_changed", "stats", "device_connected", "device_probe", "mcp_connected", "mcp_disconnected"],
  },
];

export const ALL_KINDS: SessionLogKind[] = KIND_GROUPS.flatMap((g) => g.kinds);

// src/apps/session-manager/stores/sessionLogStore.ts
//
// This window's copy of the Rust session log ring, plus the log view's UI state.

import { create } from "zustand";
import type { BadgeStyleProps } from "../../../components/Badge";
import type { SessionLogEntry } from "../../../generated/SessionLogEntry";
import type { SessionLogEvent } from "../../../generated/SessionLogEvent";
import type { IOState } from "../../../generated/IOState";
import type { IOProfile } from "../../../hooks/useSettings";
import { SESSION_LOG_CAPACITY } from "../../../generated/wireConstants";
import { getStateType } from "../../../api/io";

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

const MODE_LABELS = { live: "Live", recorded: "Playback", capture: "Capture", replaying: "Replaying" } as const;

const TRANSITION_LABELS = {
  suspended: "Suspended",
  switched_to_capture: "Switched to capture",
  resuming: "Resuming",
  returned_to_live: "Returned to live",
  capabilities_changed: "Capabilities changed",
} as const;

function stateLabel(state: IOState): string {
  return state.type === "Error" ? `error: ${state.message}` : getStateType(state);
}

function listeners(count: number): string {
  return `${count} listener${count === 1 ? "" : "s"}`;
}

/** The kinds the badge and filter treat as one: a stream that ended at its end is a completion. */
export function displayKind(event: SessionLogEvent): SessionLogKind | "stream_complete" {
  return event.kind === "stream_ended" && event.reason === "paused" ? "stream_complete" : event.kind;
}

export function describeEvent(event: SessionLogEvent, who: string | null): string {
  switch (event.kind) {
    case "created":
      return `Session created (${MODE_LABELS[event.mode]})`;
    case "joined":
      return `${who ?? "Listener"} joined (${listeners(event.subscriber_count)})`;
    case "left":
      return `${who ?? "Listener"} left (${listeners(event.subscriber_count)})`;
    case "destroyed":
      return event.reset ? "Session destroyed (reset)" : "Session destroyed";
    case "state":
      return `State: ${stateLabel(event.state)}`;
    case "transitioned":
      return `${TRANSITION_LABELS[event.transition]} (${MODE_LABELS[event.mode]})`;
    case "speed":
      return `Speed: ${event.speed}x`;
    case "reconfigured":
      return "Session reconfigured";
    case "capture_changed":
      return "Session captures changed";
    case "stream_ended":
      if (event.reason === "paused") return "Stream completed";
      return `Reason: ${event.reason}, capture: ${event.capture_count === null ? "none" : `${event.capture_count} items`}`;
    case "error":
      return event.message;
    case "device_connected":
      return `${event.source_type} connected: ${event.address}${event.bus === null ? "" : ` (bus ${event.bus})`}`;
    case "device_probe": {
      const outcome = event.success ? `${event.bus_count} bus(es)` : (event.error ?? "failed");
      return `${event.source_type} at ${event.address}: ${outcome}${event.cached ? " (cached)" : ""}`;
    }
    case "mcp_connected":
      return `MCP client connected (${event.client.slice(0, 8)})`;
    case "mcp_disconnected":
      return `MCP client disconnected (${event.client.slice(0, 8)})`;
    case "stats":
      return `State: ${getStateType(event.state)}, Listeners: ${event.subscriber_count}, Frames: ${event.frame_count}`;
    case "cleared":
      return "Log cleared";
  }
}

export function describeEntry(entry: SessionLogEntry): string {
  return describeEvent(entry.event, entry.app_name ?? entry.subscriber_id);
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

export const KIND_LABELS: Record<SessionLogKind | "stream_complete", string> = {
  created: "Created",
  joined: "Joined",
  left: "Left",
  destroyed: "Destroyed",
  state: "State",
  transitioned: "Transition",
  stream_ended: "Ended",
  stream_complete: "Complete",
  error: "Error",
  speed: "Speed",
  reconfigured: "Reconfigured",
  capture_changed: "Capture",
  stats: "Stats",
  device_connected: "Connected",
  device_probe: "Probe",
  mcp_connected: "MCP Connect",
  mcp_disconnected: "MCP Disconnect",
  cleared: "Cleared",
};

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

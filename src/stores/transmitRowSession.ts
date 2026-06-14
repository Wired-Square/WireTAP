// Copyright 2026 Wired Square Pty Ltd
//
// Resolve a transmit queue row to its backend session. Rows carry the
// authoritative `sessionId` (agent rows and new UI rows); legacy/bulk rows
// fall back to the first connected session matching their profileId.

import type { Session } from "./sessionStore";

export function resolveQueueItemSession(
  item: { sessionId?: string; profileId: string },
  sessions: Record<string, Session>
): Session | undefined {
  if (item.sessionId && sessions[item.sessionId]) return sessions[item.sessionId];
  return Object.values(sessions).find(
    (s) => s && s.profileId === item.profileId && s.lifecycleState === "connected"
  );
}

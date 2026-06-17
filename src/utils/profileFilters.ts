// Profile filtering utilities for bookmark creation
//
// Filters IO profiles based on their capabilities.

import type { IOProfile } from '../apps/settings/stores/settingsStore';

/** Profile kinds that support time range filtering for bookmarks */
const TIME_RANGE_CAPABLE_KINDS = ['postgres', 'wiretap'] as const;

/**
 * Whether a profile kind is a recorded database source (PostgreSQL or the
 * WireTAP backend) — these support time-range queries and a default speed.
 */
export function isTimeRangeCapableKind(kind: string | undefined): boolean {
  return TIME_RANGE_CAPABLE_KINDS.includes(kind as typeof TIME_RANGE_CAPABLE_KINDS[number]);
}

/**
 * Filter profiles to only those that support time range queries.
 * PostgreSQL and WireTAP backend profiles support this capability.
 */
export function getTimeRangeCapableProfiles(profiles: IOProfile[]): IOProfile[] {
  return profiles.filter(p => isTimeRangeCapableKind(p.kind));
}

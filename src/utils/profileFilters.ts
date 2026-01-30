// Profile filtering utilities for bookmark creation
//
// Filters IO profiles based on their capabilities.

import type { IOProfile } from '../apps/settings/stores/settingsStore';

/** Profile kinds that support time range filtering for bookmarks */
const TIME_RANGE_CAPABLE_KINDS = ['postgres'] as const;

/**
 * Filter profiles to only those that support time range queries.
 * Currently only PostgreSQL profiles support this capability.
 */
export function getTimeRangeCapableProfiles(profiles: IOProfile[]): IOProfile[] {
  return profiles.filter(p =>
    TIME_RANGE_CAPABLE_KINDS.includes(p.kind as typeof TIME_RANGE_CAPABLE_KINDS[number])
  );
}

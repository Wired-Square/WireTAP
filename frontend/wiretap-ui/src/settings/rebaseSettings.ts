import type { IOProfile } from "./appSettings";

export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(record[k])).join(",") + "}";
}

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

/**
 * Lay what changed locally since `base` over `fresh`: whole profiles for
 * `io_profiles`, whole top-level fields for everything else.
 */
export function rebaseSettings<T extends { io_profiles: IOProfile[] }>(base: T, local: T, fresh: T): T {
  const merged = { ...fresh };
  for (const key of Object.keys(fresh) as (keyof T)[]) {
    if (!same(local[key], base[key])) merged[key] = local[key];
  }
  merged.io_profiles = rebaseProfiles(base.io_profiles, local.io_profiles, fresh.io_profiles);
  return merged;
}

function rebaseProfiles(base: IOProfile[], local: IOProfile[], fresh: IOProfile[]): IOProfile[] {
  const baseById = new Map(base.map((p) => [p.id, p]));
  const localById = new Map(local.map((p) => [p.id, p]));
  const freshIds = new Set(fresh.map((p) => p.id));

  const editedLocally = (p: IOProfile) => {
    const before = baseById.get(p.id);
    return before === undefined || !same(p, before);
  };
  const removedLocally = (id: string) => baseById.has(id) && !localById.has(id);

  const rebased = fresh
    .filter((p) => !removedLocally(p.id))
    .map((p) => {
      const mine = localById.get(p.id);
      return mine && editedLocally(mine) ? mine : p;
    });
  const onlyMine = local.filter((p) => !freshIds.has(p.id) && editedLocally(p));
  return [...rebased, ...onlyMine];
}

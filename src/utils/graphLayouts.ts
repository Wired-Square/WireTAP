// ui/src/utils/graphLayouts.ts
//
// Persistence utilities for graph panel layouts.
// Uses the centralised store API (ui-state.json) for multi-window safety.

import { storeGet, storeSet } from '../api/store';
import type { GraphPanel, LayoutItem } from '../stores/graphStore';

const GRAPH_LAYOUTS_KEY = 'graph.layouts';

/** A saved graph layout configuration */
export interface GraphLayout {
  id: string;
  name: string;
  catalogFilename: string;
  panels: GraphPanel[];
  layout: LayoutItem[];
  createdAt: number;
  updatedAt: number;
}

function generateId(): string {
  return `gl_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** Extract filename from a full catalog path */
export function catalogFilenameFromPath(path: string | null): string {
  if (!path) return '';
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || '';
}

/** Retrieve all saved graph layouts */
export async function getAllGraphLayouts(): Promise<GraphLayout[]> {
  return (await storeGet<GraphLayout[]>(GRAPH_LAYOUTS_KEY)) || [];
}

/** Save a new graph layout */
export async function saveGraphLayout(
  name: string,
  catalogFilename: string,
  panels: GraphPanel[],
  layout: LayoutItem[],
): Promise<GraphLayout> {
  const layouts = await getAllGraphLayouts();
  const newLayout: GraphLayout = {
    id: generateId(),
    name,
    catalogFilename,
    panels: structuredClone(panels),
    layout: structuredClone(layout),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  layouts.push(newLayout);
  await storeSet(GRAPH_LAYOUTS_KEY, layouts);
  return newLayout;
}

/** Delete a saved graph layout by ID */
export async function deleteGraphLayout(id: string): Promise<boolean> {
  const layouts = await getAllGraphLayouts();
  const idx = layouts.findIndex((l) => l.id === id);
  if (idx === -1) return false;
  layouts.splice(idx, 1);
  await storeSet(GRAPH_LAYOUTS_KEY, layouts);
  return true;
}

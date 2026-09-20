// src/apps/query/hooks/useQueryHandlers.ts
//
// Orchestrator hook that composes all Query domain handlers.

import {
  useQuerySessionHandlers,
  type QuerySessionHandlers,
} from "./handlers/useQuerySessionHandlers";
import {
  useQueryUIHandlers,
  type QueryUIHandlers,
} from "./handlers/useQueryUIHandlers";
import type { LoadOptions } from "../../../hooks/useIOSessionManager";

export interface UseQueryHandlersParams {
  // Session manager actions
  watchSource: (
    profileIds: string[],
    options: LoadOptions
  ) => Promise<void>;
  stopWatch: () => Promise<void>;

  // Profile state
  sourceProfileId: string | null;

  // Dialog controls
  openIoSessionPicker: () => void;
  openCatalogPicker: () => void;
  closeCatalogPicker: () => void;
  openErrorDialog: () => void;
  closeErrorDialog: () => void;

  // Tab state
  setActiveTab: (tab: string) => void;
}

export type QueryHandlers = QuerySessionHandlers & QueryUIHandlers;

export function useQueryHandlers(params: UseQueryHandlersParams): QueryHandlers {
  // Session handlers (ingest, stop)
  const sessionHandlers = useQuerySessionHandlers({
    watchSource: params.watchSource,
    stopWatch: params.stopWatch,
    sourceProfileId: params.sourceProfileId,
  });

  // UI handlers (dialogs, tabs, queue, export)
  const uiHandlers = useQueryUIHandlers({
    openCatalogPicker: params.openCatalogPicker,
    closeCatalogPicker: params.closeCatalogPicker,
    openErrorDialog: params.openErrorDialog,
    closeErrorDialog: params.closeErrorDialog,
    setActiveTab: params.setActiveTab,
  });

  // Spread all handlers into a flat object
  return {
    ...sessionHandlers,
    ...uiHandlers,
  };
}

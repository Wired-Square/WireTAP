// ui/src/apps/catalog/hooks/index.ts

export { useCatalogForms } from "./useCatalogForms";
export type { SignalFields, MuxFields } from "./useCatalogForms";
export { useCatalogHandlers } from "./useCatalogHandlers";
export type { CatalogHandlers, UseCatalogHandlersParams } from "./useCatalogHandlers";

// Domain-specific handlers (for direct use if needed)
export {
  useFileHandlers,
  useSignalHandlers,
  useMuxHandlers,
  useFrameHandlers,
} from "./handlers";

// ui/src/api/index.ts
// Central export point for all Tauri API calls

// Settings API
export {
  loadSettings,
  saveSettings,
  validateDirectory,
  createDirectory,
  getAppVersion,
  settingsPanelClosed,
  openSettingsPanel,
} from "./settings";

// Catalog API
export {
  openCatalog,
  saveCatalog,
  validateCatalog,
  testDecodeFrame,
  listCatalogs,
  duplicateCatalog,
  renameCatalog,
  deleteCatalog,
  type CatalogMetadata,
  type ValidationError,
  type ValidationResult,
} from "./catalog";

// Discovery/Streaming API
export {
  startCanStream,
  stopCanStream,
  updatePlaybackSpeed,
  type StartStreamOptions,
} from "./discovery";

// Dialog API
export {
  pickFileToOpen,
  pickFileToSave,
  pickDirectory,
  pickCatalogToOpen,
  pickCatalogToSave,
  CATALOG_FILTERS,
  type DialogFilter,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "./dialogs";

// Checksum API
export {
  calculateChecksum,
  validateChecksum,
  resolveByteIndex,
  type ChecksumAlgorithm,
  type ChecksumValidationResult,
} from "./checksums";

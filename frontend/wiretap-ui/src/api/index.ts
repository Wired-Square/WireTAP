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
  setWakeSettings,
  setLogLevel,
  tlog,
} from "./settings";

// Catalog API
export {
  openCatalog,
  saveCatalog,
  testDecodeFrame,
  listCatalogs,
  duplicateCatalog,
  renameCatalog,
  deleteCatalog,
  type CatalogMetadata,
  type ValidationError,
  type ValidationResult,
} from "./catalog";

// Catalog sharing API (git / GitHub)
export {
  parseCatalogSourceUrl,
  browseCatalogRepo,
  resolveRemoteCatalogs,
  importRemoteCatalogs,
  listCatalogSources,
  forgetCatalogSource,
  checkCatalogUpdates,
  fetchRemoteCatalog,
  applyCatalogUpdate,
  pullCatalog,
  repoStatus,
  type PullOutcome,
  type RepoStatus,
  type GitProgress,
  GIT_PROGRESS_EVENT,
  type UpdateCheckResult,
  type UpdateCheckFailure,
  type RemoteCatalogText,
  setGitToken,
  getGitIdentity,
  verifyGitToken,
  clearGitToken,
  gitTokenSetupUrl,
  preflightPublish,
  publishCatalog,
  createCatalogRepo,
  refreshPrStatus,
  asShareError,
  GIT_HOST,
  PUBLISH_PROGRESS_EVENT,
  type GitIdentity,
  type PublishRequest,
  type PublishPlan,
  type PublishAction,
  type PublishResult,
  type PublishProgress,
  type PublishStep,
  type SecretFinding,
  type TrackedPr,
  type CatalogSource,
  type ShareError,
  type ShareErrorKind,
  type RepoInfo,
  type RemoteEntry,
  type RepoBrowse,
  type RemoteCatalog,
  type CollisionPolicy,
  type ImportRequest,
  type ImportResult,
  type ImportOutcome,
  type LocalState,
  type CatalogSyncStatus,
  type TrackedCatalog,
  type CatalogSourcesView,
  saveCatalogRepo,
  forgetCatalogRepo,
  setFavouriteCatalogRepo,
  saveCommunityRepo,
  forgetCommunityRepo,
  savedRepoName,
  type SavedRepo,
  type SavedReposView,
  type SaveRepoResult,
  type CommunityRepoView,
  type CommunityReposView,
} from "./catalogShare";

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

// Menu API
export {
  updateMenuState,
  updateBookmarksMenu,
  type MenuState,
  type BookmarkMenuInfo,
} from "./menu";

// Checksum API
export {
  calculateChecksum,
  validateChecksum,
  resolveByteIndex,
  type ChecksumAlgorithm,
  type ChecksumValidationResult,
} from "./checksums";

// BLE Provisioning API
export {
  bleScanStart,
  bleScanStop,
  bleConnect,
  bleDeleteAllCredentials,
  bleWifiDisconnect,
  bleReadDeviceState,
  bleProvisionWifi,
  bleSubscribeStatus,
  bleGetHostWifiSsid,
  SECURITY_OPEN,
  SECURITY_WPA2_PSK,
  STATUS_DISCONNECTED,
  STATUS_CONNECTING,
  STATUS_CONNECTED,
  STATUS_ERROR,
  type BleDevice,
  type DeviceWifiState,
  type WifiCredentials,
  type ProvisioningStatus,
} from "./bleProvision";

// SMP / OTA API
export {
  listImages,
  otaStart,
  otaCancel,
  subscribeOtaEvents,
  type ImageSlotInfo,
  type Transport,
  type OtaStartParams,
  type OtaEvent,
} from "./smpUpgrade";

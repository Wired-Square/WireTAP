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
  updateMenuSessionState,
  updateBookmarksMenu,
  updateMenuFocusState,
  type MenuSessionState,
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
  bleDisconnect,
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

// SMP Firmware Upgrade API
export {
  smpScanStart,
  smpScanStop,
  smpConnectBle,
  smpConnectUdp,
  smpDisconnect,
  smpListImages,
  smpUploadFirmware,
  smpTestImage,
  smpConfirmImage,
  smpResetDevice,
  smpCancelUpload,
  type ImageSlotInfo,
  type UploadProgress,
} from "./smpUpgrade";

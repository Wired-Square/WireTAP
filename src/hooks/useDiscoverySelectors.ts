// ui/src/hooks/useDiscoverySelectors.ts
// Grouped selector hooks for Discovery store to reduce boilerplate

import { useDiscoveryStore } from "../stores/discoveryStore";

/**
 * Frame-related state selectors
 */
export function useDiscoveryFrameState() {
  const frames = useDiscoveryStore((s) => s.frames);
  const frameInfoMap = useDiscoveryStore((s) => s.frameInfoMap);
  const selectedFrames = useDiscoveryStore((s) => s.selectedFrames);
  const maxBuffer = useDiscoveryStore((s) => s.maxBuffer);

  return { frames, frameInfoMap, selectedFrames, maxBuffer };
}

/**
 * Frame actions
 */
export function useDiscoveryFrameActions() {
  const addFrames = useDiscoveryStore((s) => s.addFrames);
  const clearBuffer = useDiscoveryStore((s) => s.clearBuffer);
  const clearFramePicker = useDiscoveryStore((s) => s.clearFramePicker);
  const toggleFrameSelection = useDiscoveryStore((s) => s.toggleFrameSelection);
  const bulkSelectBus = useDiscoveryStore((s) => s.bulkSelectBus);
  const setMaxBuffer = useDiscoveryStore((s) => s.setMaxBuffer);
  const selectAllFrames = useDiscoveryStore((s) => s.selectAllFrames);
  const deselectAllFrames = useDiscoveryStore((s) => s.deselectAllFrames);

  return {
    addFrames,
    clearBuffer,
    clearFramePicker,
    toggleFrameSelection,
    bulkSelectBus,
    setMaxBuffer,
    selectAllFrames,
    deselectAllFrames,
  };
}

/**
 * Playback-related state selectors
 */
export function useDiscoveryPlaybackState() {
  const ioProfile = useDiscoveryStore((s) => s.ioProfile);
  const playbackSpeed = useDiscoveryStore((s) => s.playbackSpeed);
  const startTime = useDiscoveryStore((s) => s.startTime);
  const endTime = useDiscoveryStore((s) => s.endTime);
  const currentTime = useDiscoveryStore((s) => s.currentTime);

  return { ioProfile, playbackSpeed, startTime, endTime, currentTime };
}

/**
 * Playback actions
 */
export function useDiscoveryPlaybackActions() {
  const setIoProfile = useDiscoveryStore((s) => s.setIoProfile);
  const setPlaybackSpeed = useDiscoveryStore((s) => s.setPlaybackSpeed);
  const setStartTime = useDiscoveryStore((s) => s.setStartTime);
  const setEndTime = useDiscoveryStore((s) => s.setEndTime);
  const updateCurrentTime = useDiscoveryStore((s) => s.updateCurrentTime);

  return {
    setIoProfile,
    setPlaybackSpeed,
    setStartTime,
    setEndTime,
    updateCurrentTime,
  };
}

/**
 * Error dialog state and actions
 */
export function useDiscoveryErrorDialog() {
  const showErrorDialog = useDiscoveryStore((s) => s.showErrorDialog);
  const errorDialogTitle = useDiscoveryStore((s) => s.errorDialogTitle);
  const errorDialogMessage = useDiscoveryStore((s) => s.errorDialogMessage);
  const errorDialogDetails = useDiscoveryStore((s) => s.errorDialogDetails);
  const showError = useDiscoveryStore((s) => s.showError);
  const closeErrorDialog = useDiscoveryStore((s) => s.closeErrorDialog);

  return {
    showErrorDialog,
    errorDialogTitle,
    errorDialogMessage,
    errorDialogDetails,
    showError,
    closeErrorDialog,
  };
}

/**
 * Save dialog state and actions
 */
export function useDiscoverySaveDialog() {
  const showSaveDialog = useDiscoveryStore((s) => s.showSaveDialog);
  const saveMetadata = useDiscoveryStore((s) => s.saveMetadata);
  const openSaveDialog = useDiscoveryStore((s) => s.openSaveDialog);
  const closeSaveDialog = useDiscoveryStore((s) => s.closeSaveDialog);
  const updateSaveMetadata = useDiscoveryStore((s) => s.updateSaveMetadata);
  const saveFrames = useDiscoveryStore((s) => s.saveFrames);

  return {
    showSaveDialog,
    saveMetadata,
    openSaveDialog,
    closeSaveDialog,
    updateSaveMetadata,
    saveFrames,
  };
}

/**
 * Toolbox state
 */
export function useDiscoveryToolbox() {
  const activeView = useDiscoveryStore((s) => s.toolbox.activeView);
  const toolboxIsRunning = useDiscoveryStore((s) => s.toolbox.isRunning);

  return { activeView, toolboxIsRunning };
}

/**
 * Knowledge/Info view state
 */
export function useDiscoveryKnowledge() {
  const showInfoView = useDiscoveryStore((s) => s.showInfoView);
  const knowledge = useDiscoveryStore((s) => s.knowledge);
  const openInfoView = useDiscoveryStore((s) => s.openInfoView);

  return { showInfoView, knowledge, openInfoView };
}

/**
 * Selection set state and actions
 */
export function useDiscoverySelectionSet() {
  const activeSelectionSetId = useDiscoveryStore((s) => s.activeSelectionSetId);
  const selectionSetDirty = useDiscoveryStore((s) => s.selectionSetDirty);
  const setActiveSelectionSet = useDiscoveryStore((s) => s.setActiveSelectionSet);
  const setSelectionSetDirty = useDiscoveryStore((s) => s.setSelectionSetDirty);
  const applySelectionSet = useDiscoveryStore((s) => s.applySelectionSet);

  return {
    activeSelectionSetId,
    selectionSetDirty,
    setActiveSelectionSet,
    setSelectionSetDirty,
    applySelectionSet,
  };
}

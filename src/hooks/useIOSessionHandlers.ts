// src/hooks/useIOSessionHandlers.ts
//
// Centralized IO session handlers shared across Decoder, Discovery, and Transmit.
// Provides common patterns for skip, join, detach, rejoin, and multi-bus session management.

import { useCallback } from "react";
import {
  createAndStartMultiSourceSession,
  joinMultiSourceSession,
  type CreateMultiSourceOptions,
} from "../stores/sessionStore";

export interface UseIOSessionHandlersParams {
  // App identifier for session management
  appName: string;

  // Session management functions from useIOSession/useIOSessionManager
  leave: () => Promise<void>;
  rejoin: (sessionId?: string, sessionName?: string) => Promise<void>;

  // Multi-bus state
  multiBusMode: boolean;
  setMultiBusMode: (mode: boolean) => void;
  setMultiBusProfiles: (profiles: string[]) => void;

  // IO profile state
  setIoProfile: (profileId: string | null) => void;

  // Activity state (isWatching, isStreaming, etc.)
  isActive: boolean;
  setIsActive?: (active: boolean) => void;

  // Detached state (optional - some apps don't use this)
  setIsDetached?: (detached: boolean) => void;

  // Dialog control
  closeDialog: () => void;

  // Profile names map for multi-source sessions
  profileNamesMap?: Map<string, string>;

  // Optional app-specific hooks
  onBeforeSkip?: () => Promise<void>;
  onAfterJoin?: () => void;
}

export interface IOSessionHandlers {
  handleSkip: () => Promise<void>;
  handleJoinSession: (sessionId: string, sourceProfileIds?: string[]) => Promise<void>;
  handleDetach: () => Promise<void>;
  handleRejoin: () => Promise<void>;
  handleSelectMultiple: (profileIds: string[]) => void;
  createMultiSourceSession: (options: Omit<CreateMultiSourceOptions, "listenerId">) => Promise<void>;
}

export function useIOSessionHandlers({
  appName,
  leave,
  rejoin,
  multiBusMode: _multiBusMode, // Available for app-specific hooks via closure
  setMultiBusMode,
  setMultiBusProfiles,
  setIoProfile,
  isActive,
  setIsActive,
  setIsDetached,
  closeDialog,
  profileNamesMap,
  onBeforeSkip,
  onAfterJoin,
}: UseIOSessionHandlersParams): IOSessionHandlers {
  // Handle skipping IO picker (continue without reader)
  const handleSkip = useCallback(async () => {
    // Run app-specific cleanup first
    if (onBeforeSkip) {
      await onBeforeSkip();
    }

    // Clear multi-bus state
    setMultiBusMode(false);
    setMultiBusProfiles([]);

    // Leave the session if active
    if (isActive) {
      await leave();
      setIsActive?.(false);
    }

    // Clear the profile selection
    setIoProfile(null);
    closeDialog();
  }, [
    onBeforeSkip,
    setMultiBusMode,
    setMultiBusProfiles,
    isActive,
    leave,
    setIsActive,
    setIoProfile,
    closeDialog,
  ]);

  // Handle joining an existing session from IO picker dialog
  const handleJoinSession = useCallback(
    async (sessionId: string, sourceProfileIds?: string[]) => {
      // Use centralized helper to join multi-source session
      await joinMultiSourceSession({
        sessionId,
        listenerId: appName,
        sourceProfileIds,
      });

      // Update UI state
      setIoProfile(sessionId);
      setMultiBusProfiles(sourceProfileIds || []);
      // Always use single-session mode when joining (even for multi-source sessions)
      setMultiBusMode(false);
      setIsDetached?.(false);

      // Build session name for display
      const sessionName =
        sourceProfileIds && sourceProfileIds.length > 1
          ? `Multi-Bus (${sourceProfileIds.length} sources)`
          : sessionId;

      await rejoin(sessionId, sessionName);
      closeDialog();

      // Run app-specific post-join hook
      onAfterJoin?.();
    },
    [
      appName,
      setIoProfile,
      setMultiBusProfiles,
      setMultiBusMode,
      setIsDetached,
      rejoin,
      closeDialog,
      onAfterJoin,
    ]
  );

  // Handle detaching from shared session without stopping it
  const handleDetach = useCallback(async () => {
    await leave();
    setIsDetached?.(true);
    setIsActive?.(false);
  }, [leave, setIsDetached, setIsActive]);

  // Handle rejoining a session after detaching
  const handleRejoin = useCallback(async () => {
    await rejoin();
    setIsDetached?.(false);
    setIsActive?.(true);
  }, [rejoin, setIsDetached, setIsActive]);

  // Handle selecting multiple profiles for multi-bus mode
  const handleSelectMultiple = useCallback(
    (profileIds: string[]) => {
      setMultiBusProfiles(profileIds);
      setIoProfile(null); // Clear single profile selection
    },
    [setMultiBusProfiles, setIoProfile]
  );

  // Create a multi-source session (wrapper around sessionStore helper)
  const createMultiSourceSession = useCallback(
    async (options: Omit<CreateMultiSourceOptions, "listenerId">) => {
      await createAndStartMultiSourceSession({
        ...options,
        listenerId: appName,
        profileNames: profileNamesMap,
      });
    },
    [appName, profileNamesMap]
  );

  return {
    handleSkip,
    handleJoinSession,
    handleDetach,
    handleRejoin,
    handleSelectMultiple,
    createMultiSourceSession,
  };
}

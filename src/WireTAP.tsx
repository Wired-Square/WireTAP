// ui/WireTAP.tsx

import * as Sentry from "@sentry/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./WireTAP.css";
import MainLayout from "./components/MainLayout";
import { useUpdateStore } from "./stores/updateStore";
import { useTheme } from "./hooks/useTheme";
import { useAppErrorDialog, useSessionStore } from "./stores/sessionStore";
import { useSettingsStore } from "./apps/settings/stores/settingsStore";
import { checkRecoveryOccurred } from "./api/io";
import { checkCandorMigration, tlog } from "./api/settings";
import type { CandorMigrationInfo } from "./api/settings";
import ErrorDialog from "./dialogs/ErrorDialog";
import TelemetryConsentDialog from "./dialogs/TelemetryConsentDialog";
import CandorMigrationDialog from "./dialogs/CandorMigrationDialog";

// Lazy load AboutDialog since it's rarely used
const AboutDialog = lazy(() => import("./dialogs/AboutDialog"));

// Loading fallback component
function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-screen bg-slate-900">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-sm text-slate-400">Loading...</span>
      </div>
    </div>
  );
}

/** Enable or disable the Sentry client at runtime */
function setSentryEnabled(enabled: boolean) {
  const client = Sentry.getClient();
  if (client) {
    client.getOptions().enabled = enabled;
  }
}

export default function WireTAP() {
  const [showAbout, setShowAbout] = useState(false);
  const [showConsentDialog, setShowConsentDialog] = useState(false);
  const [migrationInfo, setMigrationInfo] = useState<CandorMigrationInfo | null>(null);
  const currentWindow = getCurrentWebviewWindow();
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);

  // Global app error dialog state
  const { isOpen: appErrorOpen, title: appErrorTitle, message: appErrorMessage, details: appErrorDetails, closeAppError } = useAppErrorDialog();

  // Load settings store eagerly so all apps have access to IO profiles,
  // preferred catalogs, etc. without requiring the Settings panel to be open.
  const loadSettingsStore = useSettingsStore((s) => s.loadSettings);
  useEffect(() => {
    loadSettingsStore();
  }, [loadSettingsStore]);

  // Telemetry consent state
  const settingsLoaded = useSettingsStore((s) => s.originalSettings !== null);
  const telemetryEnabled = useSettingsStore((s) => s.general.telemetryEnabled);
  const telemetryConsentGiven = useSettingsStore((s) => s.general.telemetryConsentGiven);
  const setTelemetryEnabled = useSettingsStore((s) => s.setTelemetryEnabled);
  const setTelemetryConsentGiven = useSettingsStore((s) => s.setTelemetryConsentGiven);

  // Apply global theme (dark/light mode + CSS variables)
  useTheme();

  // Check for updates on launch
  useEffect(() => {
    checkForUpdates();
  }, [checkForUpdates]);

  useEffect(() => {
    const unlistenAbout = currentWindow.listen("show-about", () => {
      setShowAbout(true);
    });

    return () => {
      unlistenAbout.then((fn) => fn());
    };
  }, [currentWindow]);

  // Check for old CANdor data on startup
  useEffect(() => {
    if (settingsLoaded) {
      checkCandorMigration().then((info) => {
        if (info) setMigrationInfo(info);
      });
    }
  }, [settingsLoaded]);

  // Show consent dialog on first boot (or upgrade without the setting)
  useEffect(() => {
    if (settingsLoaded && !telemetryConsentGiven) {
      setShowConsentDialog(true);
    }
  }, [settingsLoaded, telemetryConsentGiven]);

  // Enable/disable Sentry based on consent + preference
  useEffect(() => {
    if (settingsLoaded && telemetryConsentGiven) {
      setSentryEnabled(telemetryEnabled);
    }
  }, [settingsLoaded, telemetryConsentGiven, telemetryEnabled]);

  // Check if the page was reloaded by the watchdog after a WebView content
  // process jettison (macOS reclaims WKWebView memory under pressure).
  useEffect(() => {
    checkRecoveryOccurred().then((recovered) => {
      if (recovered) {
        tlog.info("[recovery] WebView recovered from system memory event");
        useSessionStore.getState().showAppError(
          "Session Recovered",
          "The system reclaimed memory from this window and the page was automatically reloaded. Your session has been reconnected.",
        );
      }
    });
  }, []);

  const handleConsentAccept = () => {
    setTelemetryEnabled(true);
    setTelemetryConsentGiven(true);
    setShowConsentDialog(false);
    setSentryEnabled(true);
  };

  const handleConsentDecline = () => {
    setTelemetryEnabled(false);
    setTelemetryConsentGiven(true);
    setShowConsentDialog(false);
  };

  return (
    <>
      <Suspense fallback={null}>
        <AboutDialog isOpen={showAbout} onClose={() => setShowAbout(false)} />
      </Suspense>
      <Sentry.ErrorBoundary fallback={<LoadingFallback />}>
        <Suspense fallback={<LoadingFallback />}>
          <MainLayout />
        </Suspense>
      </Sentry.ErrorBoundary>
      {/* Global app error dialog - shown for errors across all apps */}
      <ErrorDialog
        isOpen={appErrorOpen}
        title={appErrorTitle}
        message={appErrorMessage}
        details={appErrorDetails ?? undefined}
        onClose={closeAppError}
      />
      {/* Telemetry consent dialog - shown on first boot */}
      <TelemetryConsentDialog
        isOpen={showConsentDialog}
        onAccept={handleConsentAccept}
        onDecline={handleConsentDecline}
      />
      {/* CANdor migration dialog - shown when old data is detected */}
      {migrationInfo && (
        <CandorMigrationDialog
          open={!showConsentDialog}
          info={migrationInfo}
          onComplete={() => setMigrationInfo(null)}
        />
      )}
    </>
  );
}

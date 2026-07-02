// ui/WireTAP.tsx

import * as Sentry from "@sentry/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import i18n from "./i18n";
import "@fontsource/ubuntu/400.css";
import "@fontsource/ubuntu/500.css";
import "@fontsource/ubuntu/700.css";
import "@fontsource/ubuntu-mono/400.css";
import "@fontsource/ubuntu-mono/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/dseg7/classic-400.css";
import "./WireTAP.css";
import MainLayout from "./components/MainLayout";
import { useUpdateStore } from "./stores/updateStore";
import { useTheme } from "./hooks/useTheme";
import { useAppErrorDialog, useSessionStore } from "./stores/sessionStore";
import { useSettingsStore } from "./apps/settings/stores/settingsStore";
import { checkRecoveryOccurred } from "./api/io";
import { checkCandorMigration, tlog } from "./api/settings";
import { initTelemetry } from "./api/telemetry";
import { initWsTransport } from "./services/wsTransport";
import { initMcpBridge } from "./services/mcpBridge";
import "./services/memoryDiag"; // Memory diagnostic counters
import type { CandorMigrationInfo } from "./api/settings";
import ErrorDialog from "./dialogs/ErrorDialog";
import { Shield, BarChart3 } from "lucide-react";
import ConsentDialog from "./dialogs/ConsentDialog";
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
  const loadCaptureIds = useSessionStore((s) => s.loadCaptureIds);
  useEffect(() => {
    loadSettingsStore();
    loadCaptureIds();
  }, [loadSettingsStore, loadCaptureIds]);

  // Hand the Sentry DSN to the Rust backend so it can initialise its
  // usage-analytics logs client (emission + consent gating live in Rust).
  useEffect(() => {
    initTelemetry();
  }, []);

  // Telemetry consent state
  const settingsLoaded = useSettingsStore((s) => s.originalSettings !== null);
  const language = useSettingsStore((s) => s.general.language);
  const telemetryEnabled = useSettingsStore((s) => s.general.telemetryEnabled);
  const telemetryConsentGiven = useSettingsStore((s) => s.general.telemetryConsentGiven);
  const setTelemetryEnabled = useSettingsStore((s) => s.setTelemetryEnabled);
  const setTelemetryConsentGiven = useSettingsStore((s) => s.setTelemetryConsentGiven);

  // Usage-analytics consent state (separate opt-in from crash reports)
  const usageAnalyticsEnabled = useSettingsStore((s) => s.general.usageAnalyticsEnabled);
  const usageAnalyticsConsentGiven = useSettingsStore((s) => s.general.usageAnalyticsConsentGiven);
  const setUsageAnalyticsEnabled = useSettingsStore((s) => s.setUsageAnalyticsEnabled);
  const setUsageAnalyticsConsentGiven = useSettingsStore((s) => s.setUsageAnalyticsConsentGiven);
  const installId = useSettingsStore((s) => s.general.installId);
  const setInstallId = useSettingsStore((s) => s.setInstallId);

  // Apply global theme (dark/light mode + CSS variables)
  useTheme();

  // Sync the active i18n language with the user's setting. Runs whenever the
  // language preference changes (and on initial settings load).
  useEffect(() => {
    if (language && language !== i18n.language) {
      void i18n.changeLanguage(language);
    }
  }, [language]);

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

  // Establish binary WebSocket transport once settings are ready
  useEffect(() => {
    if (settingsLoaded) {
      initWsTransport();
      initMcpBridge();
    }
  }, [settingsLoaded]);

  // Generate a random anonymous per-install id once, so Sentry can count
  // distinct installs. Persists through the normal settings-save path.
  useEffect(() => {
    if (settingsLoaded && !installId) {
      setInstallId(crypto.randomUUID());
    }
  }, [settingsLoaded, installId, setInstallId]);

  // Show crash-report consent dialog on first boot (or upgrade without the setting)
  useEffect(() => {
    if (settingsLoaded && !telemetryConsentGiven) {
      setShowConsentDialog(true);
    }
  }, [settingsLoaded, telemetryConsentGiven]);

  // Enable the Sentry client whenever either opt-in is on (per-event consent is
  // enforced in beforeSend), and attach the anonymous install id so "users
  // affected" counts work.
  useEffect(() => {
    if (!settingsLoaded) return;
    const enabled = telemetryEnabled || usageAnalyticsEnabled;
    setSentryEnabled(enabled);
    Sentry.setUser(enabled && installId ? { id: installId } : null);
  }, [settingsLoaded, telemetryEnabled, usageAnalyticsEnabled, installId]);

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

  // Both paths record consent; the dialog's visibility is derived from
  // usageAnalyticsConsentGiven, and the effect above owns enabling Sentry.
  const handleUsageConsentAccept = () => {
    setUsageAnalyticsEnabled(true);
    setUsageAnalyticsConsentGiven(true);
  };

  const handleUsageConsentDecline = () => {
    setUsageAnalyticsEnabled(false);
    setUsageAnalyticsConsentGiven(true);
  };

  // Usage-analytics consent is shown once, sequenced after the crash-report
  // dialog: new users answer crash first, existing crash-consenters see only
  // this. Fully derived — recording consent closes it, no separate state.
  const showUsageConsent =
    settingsLoaded && telemetryConsentGiven && !usageAnalyticsConsentGiven && !showConsentDialog;

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
      {/* Crash-report consent dialog - shown on first boot */}
      <ConsentDialog
        isOpen={showConsentDialog}
        onAccept={handleConsentAccept}
        onDecline={handleConsentDecline}
        icon={Shield}
        i18nKey="telemetryConsent"
      />
      {/* Usage-analytics consent dialog - shown after the crash-report dialog */}
      <ConsentDialog
        isOpen={showUsageConsent}
        onAccept={handleUsageConsentAccept}
        onDecline={handleUsageConsentDecline}
        icon={BarChart3}
        i18nKey="usageAnalyticsConsent"
      />
      {/* CANdor migration dialog - shown when old data is detected */}
      {migrationInfo && (
        <CandorMigrationDialog
          open={!showConsentDialog && !showUsageConsent}
          info={migrationInfo}
          onComplete={() => setMigrationInfo(null)}
        />
      )}
    </>
  );
}

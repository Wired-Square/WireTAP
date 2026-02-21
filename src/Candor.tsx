// ui/Candor.tsx

import * as Sentry from "@sentry/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./Candor.css";
import MainLayout from "./components/MainLayout";
import { useUpdateStore } from "./stores/updateStore";
import { useTheme } from "./hooks/useTheme";
import { useAppErrorDialog } from "./stores/sessionStore";
import ErrorDialog from "./dialogs/ErrorDialog";

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

export default function Candor() {
  const [showAbout, setShowAbout] = useState(false);
  const currentWindow = getCurrentWebviewWindow();
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);

  // Global app error dialog state
  const { isOpen: appErrorOpen, title: appErrorTitle, message: appErrorMessage, details: appErrorDetails, closeAppError } = useAppErrorDialog();

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
    </>
  );
}

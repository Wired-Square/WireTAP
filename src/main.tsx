import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";
import WireTAP from "./WireTAP";
import { isIOS } from "./utils/platform";
import { useSettingsStore } from "./apps/settings/stores/settingsStore";
import "./i18n";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  release: `wiretap@${__APP_VERSION__}`,
  environment: import.meta.env.MODE,
  enabled: false,
  // This frontend client handles crash reports only (React errors), gated on
  // the crash-report opt-in. Usage analytics are emitted as structured logs
  // from the Rust backend (src-tauri/src/telemetry.rs), which sends over native
  // HTTPS and isn't subject to the webview CSP. Dropped until consent loads.
  beforeSend(event) {
    return useSettingsStore.getState().general.telemetryEnabled ? event : null;
  },
});

// Safe area insets CSS variables are only available on iOS
isIOS().then((ios) => {
  if (ios) import("@saurl/tauri-plugin-safe-area-insets-css-api");
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WireTAP />
  </React.StrictMode>,
);

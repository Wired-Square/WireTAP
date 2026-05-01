import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";
import WireTAP from "./WireTAP";
import { isIOS } from "./utils/platform";
import "./i18n";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  release: `wiretap@${__APP_VERSION__}`,
  environment: import.meta.env.MODE,
  enabled: false,
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

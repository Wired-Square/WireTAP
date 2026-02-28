import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";
import WireTAP from "./WireTAP";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  release: `wiretap@${__APP_VERSION__}`,
  environment: import.meta.env.MODE,
  enabled: false,
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WireTAP />
  </React.StrictMode>,
);

import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";
import Candor from "./Candor";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  release: `candor@${__APP_VERSION__}`,
  environment: import.meta.env.MODE,
  enabled: !!import.meta.env.VITE_SENTRY_DSN,
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Candor />
  </React.StrictMode>,
);

// src/api/telemetry.ts
//
// Anonymous feature-usage telemetry. The actual Sentry emission happens in the
// Rust backend (`src-tauri/src/telemetry.rs`), which sends structured logs over
// native HTTPS — bypassing the webview CSP that blocked frontend uploads.
//
// IO source-starts are emitted natively in Rust (at session creation, where the
// source kind is known — no frontend involvement). This helper covers
// frontend-only events (currently app-panel opens) by invoking the
// `track_feature_usage` command. Consent is re-checked authoritatively in Rust;
// the check here just avoids a needless IPC round-trip when analytics is off.
// Pass only low-cardinality, non-identifying `feature` values (e.g. a panel id).

import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../apps/settings/stores/settingsStore";

/** Hand the Sentry DSN to the Rust backend once, so it can init its logs client. */
export function initTelemetry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (dsn) void invoke("telemetry_init", { dsn });
}

/** Record an anonymous feature-usage event (emitted as a Sentry log by Rust). */
export function trackFeatureUsage(event: string, feature: string) {
  if (!useSettingsStore.getState().general.usageAnalyticsEnabled) return;
  void invoke("track_feature_usage", { event, feature });
}

// Copyright 2026 Wired Square Pty Ltd
//
// App health — WS command wrappers for backend status the UI must surface.

import { wsTransport } from "../services/wsTransport";

/** Something about startup the user must be told, and how loudly. */
export interface StartupNotice {
  /** `"error"` — a subsystem is dead for this run; `"info"` — finished news. */
  level: "error" | "info";
  message: string;
}

/**
 * Notices from backend startup: setup-time component failures (capture
 * database, transmit history, …) at `"error"`, and completed migrations at
 * `"info"`.
 */
export function getStartupNotices(): Promise<StartupNotice[]> {
  return wsTransport.command("app.startup_notices", {});
}

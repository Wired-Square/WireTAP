// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// App health — WS command wrappers for backend status the UI must surface.

import { wsTransport } from "../services/wsTransport";

/**
 * Failures from backend setup-time component initialisation (capture
 * database, transmit history, …). Non-empty means a subsystem is dead for
 * this run and the user must be told.
 */
export function getStartupErrors(): Promise<string[]> {
  return wsTransport.command("app.startup_errors", {});
}

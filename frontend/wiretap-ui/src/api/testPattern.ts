// src/api/testPattern.ts
//
// Tauri API wrappers for the Test Pattern protocol.

import { invoke } from "@tauri-apps/api/core";
import type { AutoPhaseResult } from "../generated/AutoPhaseResult";
import type { IOTestState } from "../generated/IOTestState";
import type { LatencyStats } from "../generated/LatencyStats";
import type { PeerInfo } from "../generated/PeerInfo";
import type { RemoteStats } from "../generated/RemoteStats";
import type { SweepRow } from "../generated/SweepRow";
import type { TestConfig } from "../generated/TestConfig";
import type { TestMode } from "../generated/TestMode";
import type { TestRole } from "../generated/TestRole";
import type { TestStatus } from "../generated/TestStatus";

export type {
  AutoPhaseResult,
  IOTestState,
  LatencyStats,
  PeerInfo,
  RemoteStats,
  SweepRow,
  TestConfig,
  TestMode,
  TestRole,
  TestStatus,
};

// ============================================================================
// Commands
// ============================================================================

export async function ioTestStart(
  sessionId: string,
  testId: string,
  config: TestConfig,
): Promise<string> {
  return invoke<string>("io_test_start", {
    session_id: sessionId,
    test_id: testId,
    config,
  });
}

export async function ioTestStop(testId: string): Promise<void> {
  return invoke("io_test_stop", { test_id: testId });
}

export async function getIOTestState(testId: string): Promise<IOTestState | null> {
  return invoke<IOTestState | null>("get_io_test_state", { test_id: testId });
}

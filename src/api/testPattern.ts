// src/api/testPattern.ts
//
// Tauri API wrappers for the Test Pattern protocol.

import { invoke } from "@tauri-apps/api/core";

// ============================================================================
// Types
// ============================================================================

export type TestMode = "echo" | "throughput" | "latency" | "reliability" | "loopback";
export type TestRole = "initiator" | "responder";

export interface TestConfig {
  mode: TestMode;
  role: TestRole;
  duration_sec: number;
  rate_hz: number;
  bus: number;
  use_fd: boolean;
  use_extended: boolean;
}

export interface LatencyStats {
  min_us: number;
  max_us: number;
  mean_us: number;
  p50_us: number;
  p95_us: number;
  p99_us: number;
  count: number;
}

export interface RemoteStats {
  rx_count: number;
  tx_count: number;
  drops: number;
  fps: number;
}

export interface IOTestState {
  test_id: string;
  status: "running" | "completed" | "stopped" | "failed";
  mode: string;
  role: string;
  tx_count: number;
  rx_count: number;
  drops: number;
  duplicates: number;
  out_of_order: number;
  sequence_gaps: [number, number][];
  latency_us: LatencyStats | null;
  elapsed_sec: number;
  frames_per_sec: number;
  errors: string[];
  remote: RemoteStats | null;
}

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

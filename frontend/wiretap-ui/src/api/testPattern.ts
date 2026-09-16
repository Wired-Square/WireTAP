// src/api/testPattern.ts
//
// Tauri API wrappers for the Test Pattern protocol.

import { invoke } from "@tauri-apps/api/core";

// ============================================================================
// Types
// ============================================================================

export type TestMode =
  | "echo"
  | "sweep"
  | "throughput"
  | "latency"
  | "reliability"
  | "loopback"
  | "auto";
export type TestRole = "initiator" | "responder";

/** A responder with no run bound yet is "listening"; everything else is terminal. */
export type TestStatus = "running" | "listening" | "completed" | "stopped" | "failed";

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

/** What the Hello handshake found on the bus, before any traffic started. */
export interface PeerInfo {
  fd: boolean;
  extended: boolean;
  bus: number;
}

/**
 * One length code's sweep result. `received_len` is null when nothing came
 * back; a row fails when the echo is not exactly the length its code names.
 */
export interface SweepRow {
  code: number;
  expected_len: number;
  received_len: number | null;
  passed: boolean;
}

export interface AutoPhaseResult {
  phase: string;
  passed: boolean;
  tx_count: number;
  rx_count: number;
  drops: number;
  frames_per_sec: number;
  elapsed_sec: number;
  latency_us: LatencyStats | null;
  remote: RemoteStats | null;
  sweep: SweepRow[] | null;
  errors: string[];
}

export interface IOTestState {
  test_id: string;
  status: TestStatus;
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
  peer: PeerInfo | null;
  sweep: SweepRow[] | null;
  auto_results: AutoPhaseResult[] | null;
  auto_phase: string | null;
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

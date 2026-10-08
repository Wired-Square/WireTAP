// The oracle for the Rust ports of message order, mirror groups and byte-role
// notes: each fixture holds the inputs and what the TypeScript returned for them.

import { describe, it, expect } from "vitest";
import type { FrameMessage } from "../types/frame";
import type { FrameByteProfile } from "../api/byteRoles";
import { analyzeMessageOrder } from "../utils/analysis/messageOrderAnalysis";
import { detectMirrorFrames, toPayloadAnalysisResult, type TimestampedPayload } from "../utils/analysis/payloadAnalysis";
import messageOrder from "./fixtures/analysis/messageOrder.json";
import mirrorFrames from "./fixtures/analysis/mirrorFrames.json";
import byteNotes from "./fixtures/analysis/byteNotes.json";

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("message order golden", () => {
  it.each(messageOrder.cases.map((c) => [c.name, c] as const))("%s", (_, { input, expected }) => {
    expect(asJson(analyzeMessageOrder(input.frames as FrameMessage[], input.options))).toEqual(expected);
  });
});

describe("mirror frames golden", () => {
  it.each(mirrorFrames.cases.map((c) => [c.name, c] as const))("%s", (_, { input, expected }) => {
    const payloads = new Map<number, TimestampedPayload[]>(input.framePayloads.map((s) => [s.frameId, s.payloads]));
    expect(asJson(detectMirrorFrames(payloads, input.toleranceUs ?? undefined))).toEqual(expected);
  });
});

describe("byte notes golden", () => {
  it.each(byteNotes.cases.map((c) => [c.name, c] as const))("%s", (_, { input, expected }) => {
    expect(asJson(toPayloadAnalysisResult(input.profile as FrameByteProfile, input.isBurstFrame))).toEqual(expected);
  });
});

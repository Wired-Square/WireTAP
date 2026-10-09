// The notes the Changes and Serial Payload tools render from Rust's codes, pinned
// to the wording the TypeScript classifier wrote. The frame cases are
// `byteNotes.json`'s profiles as the lib notes them (`byteNoteCodes.json`, which
// `npm run gen:types` rewrites); the serial cases are the lib's
// `byte_roles_golden.rs` `ts_note` table.

import { describe, it, expect } from "vitest";
import i18next, { type TFunction } from "i18next";
import { resources } from "../locales";
import type { ByteNotes } from "../generated/ByteNotes";
import type { MuxSelector } from "../generated/MuxSelector";
import { caseNoteLines, frameNoteLines } from "../utils/analysis/byteNoteText";
import { candidateReasonNote } from "../utils/analysis/serialFrameAnalysis";
import byteNotes from "./fixtures/analysis/byteNotes.json";
import byteNoteCodes from "./fixtures/analysis/byteNoteCodes.json";

const i18n = i18next.createInstance();
await i18n.init({ lng: "en-AU", resources, interpolation: { escapeValue: false } });
const t = i18n.t.bind(i18n) as TFunction;

const codes = byteNoteCodes as unknown as Record<string, ByteNotes>;

/** Where the frame notes leave the TypeScript's: the lib's deviations, and a
 *  pattern with no byte order no longer reading "undefined endian". */
const frameDeviations: Record<string, string[]> = {
  "down counter, mixed sensor with no strength, looping counter with modulo 0": [
    "Counter at byte[0]: decrementing, step=2",
    "Looping counter at byte[3]: incrementing, step=3, range 1–3 (mod 0)",
    "Sensor at byte[1]: ↕ range 3–200",
    "Sensor at byte[2]: ↑ range 0–15 (50% trend)",
  ],
  "one-byte mux, cases summarised and noted in short": [
    "Mixed endianness (inferred from 3 multi-byte pattern(s))",
    "Multiplexed frame: byte[0], cases: 0, 1, 2",
    "Case 0: 2 counter, 1 static",
    "Case 1: 1 counter, 0 static",
  ],
  "pattern bytes hide their counters and sensors but not their statics": [
    "Static bytes: byte[0]=0x00",
    "16-bit counter at byte[0:1], big endian (rollover detected)",
    "16-bit sensor at byte[2:3]",
    "Text at byte[4:7]",
  ],
};

const enAU = (note: string) => note.replace(/analyz/g, "analys");

describe("byte notes golden", () => {
  it.each(byteNotes.cases.map((c) => [c.name, c] as const))("%s", (name, { input, expected }) => {
    const notes = codes[name];
    const selector = input.profile.mux?.detection.selector as MuxSelector | undefined;
    expect(frameNoteLines(t, notes.frame, selector)).toEqual((frameDeviations[name] ?? expected.notes).map(enAU));
    const cases = expected.muxCaseAnalyses ?? [];
    expect(notes.cases.map((c) => c.value)).toEqual(cases.map((c) => c.muxValue));
    notes.cases.forEach((c, i) => expect(caseNoteLines(t, c.notes, selector!)).toEqual(cases[i].notes));
  });
});

describe("serial candidate notes", () => {
  it.each([
    [{ code: "protocolMarkers" } as const, 1, "Contains common protocol markers (0xFB-0xFE)"],
    [{ code: "commandIds" } as const, 1, "Contains small sequential values (likely command IDs)"],
    [{ code: "typeSubtype", firstByteValues: 3 } as const, 2, "First byte has only 3 values (type + subtype pattern)"],
    [{ code: "deviceCount", count: 4 } as const, 1, "4 unique addresses (typical device count)"],
    [{ code: "deviceCount", count: 4 } as const, 2, "4 unique 16-bit addresses (strong pattern)"],
    [{ code: "addressCount", count: 12 } as const, 1, "12 unique addresses"],
    [{ code: "addressCount", count: 12 } as const, 2, "12 unique 16-bit addresses"],
    [{ code: "twelveBitRange" } as const, 2, "12-bit address range"],
    [{ code: "evenDistribution" } as const, 1, "Even distribution across addresses"],
    [{ code: "evenDistribution" } as const, 2, "Even distribution"],
    [{ code: "smallAddresses" } as const, 1, "Small address values (0x00-0x20)"],
    [{ code: "noZeroAddress" } as const, 1, "No zero address (typical for device IDs)"],
    [{ code: "noZeroAddress" } as const, 2, "No zero address"],
  ])("%o at %i byte(s)", (reason, len, note) => {
    expect(candidateReasonNote(reason, len)).toBe(note);
  });
});

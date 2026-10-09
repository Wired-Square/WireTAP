// ui/src/utils/analysis/byteNoteText.ts
// Byte notes, which Rust returns as codes, worded for the Changes view and its report.

import type { TFunction } from "i18next";
import type { ByteNote } from "../../generated/ByteNote";
import type { MultiBytePattern } from "../../generated/MultiBytePattern";
import type { MuxSelector } from "../../generated/MuxSelector";
import type { Trend } from "../../generated/Trend";

const MAX_CASE_SUMMARIES = 4;
const MAX_LISTED_CASES = 6;

const TREND_ARROWS: Record<Trend, string> = { increasing: "↑", decreasing: "↓", mixed: "↕" };

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");

export function formatMuxValue(value: number, selector: MuxSelector): string {
  return selector === "twoByte" ? `${Math.floor(value / 256)}:${value % 256}` : String(value);
}

/** A frame's notes; its case summaries only when there are at most four. */
export function frameNoteLines(t: TFunction, notes: ByteNote[], selector?: MuxSelector): string[] {
  const summaries = notes.filter((n) => n.code === "caseSummary").length;
  return notes
    .filter((n) => n.code !== "caseSummary" || summaries <= MAX_CASE_SUMMARIES)
    .map((n) => noteText(t, n, selector, "note"));
}

/** A mux case's notes, in the short form. */
export function caseNoteLines(t: TFunction, notes: ByteNote[], selector: MuxSelector): string[] {
  return notes.map((n) => noteText(t, n, selector, "caseNote"));
}

type Form = "note" | "caseNote";
type Words = (name: string, options?: Record<string, unknown>) => string;

function noteText(t: TFunction, note: ByteNote, selector: MuxSelector | undefined, form: Form): string {
  const key: Words = (name, options) => t(`discovery:changes.${form}.${name}`, options);
  const long: Words = (name, options) => t(`discovery:changes.note.${name}`, options);
  switch (note.code) {
    case "noSamples":
      return long("noSamples");
    case "endianness":
      return long(`endianness.${note.endianness}`, { patterns: note.patternCount });
    case "varyingLength":
      return long("varyingLength", { min: note.min, max: note.max });
    case "burst":
      return long(note.mux ? "burstMux" : "burst");
    case "identical":
      return long("identical", { samples: note.sampleCount, payload: note.payload.map(hex2).join(" ") });
    case "multiplexed": {
      const { cases } = note;
      if (note.selector === "twoByte") return long("multiplexedTwoByte", { cases: cases.length });
      return cases.length <= MAX_LISTED_CASES
        ? long("multiplexedList", { values: cases.join(", ") })
        : long("multiplexedRange", { cases: cases.length, first: cases[0], last: cases[cases.length - 1] });
    }
    case "caseSummary":
      return long("caseSummary", {
        value: formatMuxValue(note.value, selector ?? "oneByte"),
        counters: note.counters,
        statics: note.statics,
      });
    case "statics":
      return key("statics", {
        bytes: note.bytes.map((b) => long("staticByte", { position: b.position, value: hex2(b.value) })).join(", "),
      });
    case "counter": {
      const direction = key(note.direction);
      return note.looping
        ? key("loopingCounter", { position: note.position, direction, step: note.step, ...note.looping })
        : key("counter", { position: note.position, direction, step: note.step, rollover: note.rollover ? key("rollover") : "" });
    }
    case "sensor":
      return key("sensor", {
        position: note.position,
        trend: TREND_ARROWS[note.trend],
        min: note.min,
        max: note.max,
        strength: note.strength ? long("strength", { percent: Math.round(note.strength * 100) }) : "",
      });
    case "pattern":
      return patternText(key, long, note);
    case "varyingValues":
      return long("varyingValues", { bytes: note.count });
  }
}

function patternText(key: Words, long: Words, p: MultiBytePattern): string {
  const span = { start: p.start, end: p.start + p.len - 1 };
  const endian = p.endianness ? key("endian", { order: long(p.endianness) }) : "";
  switch (p.kind) {
    case "counter16":
      return key("counter16", { ...span, endian, rollover: p.rollover ? key("rollover") : "" });
    case "sensor16":
    case "sensor32":
      return key("sensorPattern", {
        ...span,
        bits: p.kind === "sensor16" ? 16 : 32,
        endian,
        range: p.range ? key("range", { min: p.range[0], max: p.range[1] }) : "",
        slow: p.slowUpperBytes ? key("slowUpper") : "",
        correlated: p.correlatedRollover ? key("correlated") : "",
      });
    case "text":
      return key("text", { ...span, sample: p.sampleText ? long("sample", { text: p.sampleText }) : "" });
  }
}

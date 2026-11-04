import { describe, it, expect } from "vitest";

import "../i18n";
import { reportLocale } from "../api/reports";
import reports from "../locales/en-AU/reports.json";
import discovery from "../locales/en-AU/discovery.json";

describe("report locale", () => {
  const { messages, groupSeparator, decimalSeparator } = reportLocale("en-AU");

  it("sends the en-AU reports bundle under its namespace", () => {
    expect(messages["reports:catalogue.title"]).toBe(reports.catalogue.title);
    expect(messages["reports:count.frame_one"]).toBe(reports.count.frame_one);
    expect(messages["reports:order.column.framesPerBus"]).toBe(reports.order.column.framesPerBus);
  });

  it("sends the Changes view's byte notes for the reports to reuse", () => {
    expect(messages["discovery:changes.note.counter"]).toBe(discovery.changes.note.counter);
    expect(messages["discovery:changes.caseNote.counter"]).toBe(discovery.changes.caseNote.counter);
  });

  it("takes the number style from the language", () => {
    expect([groupSeparator, decimalSeparator]).toEqual([",", "."]);
    const de = reportLocale("de-DE");
    expect([de.groupSeparator, de.decimalSeparator]).toEqual([".", ","]);
  });
});

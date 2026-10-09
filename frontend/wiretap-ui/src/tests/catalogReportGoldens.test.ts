// The catalogue report over `sbrxxx.toml` and two edge documents, and the Payload
// Changes and Frame Order reports, in every format the export dialogs offer. The
// reports carry no timestamp; `toLocaleString` follows the host locale.

import { describe, it } from "vitest";
import "../i18n";
import { tomlParse } from "../apps/catalog/toml";
import { generateCatalogReport, type CatalogReportFormat } from "../utils/catalogReport";
import { generatePayloadChangesReport } from "../utils/payloadChangesReport";
import { generateFrameOrderReport } from "../utils/frameOrderReport";
import { changesResult, expectGoldenText, fixtureText, frameOrders } from "./catalogGoldens";

const FORMATS = [
  ["text", "txt"],
  ["markdown", "md"],
  ["html-screen", "screen.html"],
  ["html-print", "print.html"],
] as const;

describe("catalogue report golden", () => {
  const sbrxxx = tomlParse(fixtureText("sbrxxx.toml"));

  it.each(FORMATS)("sbrxxx.toml as %s", async (format, ext) => {
    await expectGoldenText(`catalogReport.sbrxxx.${ext}`, generateCatalogReport(sbrxxx, format as CatalogReportFormat));
  });

  it.each(["report-edges", "report-legacy"])("%s.toml as text and markdown", async (name) => {
    const doc = tomlParse(fixtureText(`catalog/${name}.toml`));
    await expectGoldenText(`catalogReport.${name}.txt`, generateCatalogReport(doc, "text"));
    await expectGoldenText(`catalogReport.${name}.md`, generateCatalogReport(doc, "markdown"));
  });
});

describe("Payload Changes report golden", () => {
  it.each(FORMATS)("as %s", async (format, ext) => {
    await expectGoldenText(`payloadChanges.${ext}`, generatePayloadChangesReport(changesResult, format));
  });
});

describe("Frame Order report golden", () => {
  it.each(FORMATS)("as %s", async (format, ext) => {
    await expectGoldenText(`frameOrder.${ext}`, generateFrameOrderReport(frameOrders, format));
  });
});

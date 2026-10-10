// The CSV column mapper's timestamp preview and duration estimate beside the
// importer (`csv.rs`, checked by `csv::tests::the_importer_matches_the_preview_table`).
// A row whose `ts_us` and `rust_us` differ is a disagreement.

import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { formatOffset, previewOffsetSecs } from "../dialogs/csv-column-mapper/PreviewTable";
import { estimateDurationSecs } from "../dialogs/csv-column-mapper/CsvColumnMapperDialog";
import type { TimestampUnit } from "../api/capture";
import { fixtureJson } from "./catalogGoldens";

type Row = {
  name: string;
  cells: string[];
  unit: TimestampUnit;
  negate: boolean;
};

const table = fixtureJson<{ note: string; rows: Row[] }>("data/csvPreviewTimestamps.json");

function tsColumns({ cells, unit, negate }: Row) {
  const offsets = previewOffsetSecs(cells, unit, negate);
  return {
    ts_preview: offsets.map((offset) => (offset === null ? "—" : formatOffset(offset))),
    ts_us: offsets.map((offset) => (offset === null ? null : Math.round(offset * 1_000_000))),
    ts_duration_secs: estimateDurationSecs(cells, unit),
  };
}

describe("CSV preview timestamps", () => {
  it("matches the table's ts columns", async () => {
    const rows = table.rows.map((row) => ({ ...row, ...tsColumns(row) }));
    await expect(JSON.stringify({ ...table, rows }, null, 2) + "\n").toMatchFileSnapshot(
      resolve(__dirname, "fixtures/data/csvPreviewTimestamps.json"),
    );
  });
});

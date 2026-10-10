// The CSV column mapper's timestamp preview renders the importer's own stamps
// (`csv.rs preview_timestamps`, checked against the importer by
// `csv::tests::the_importer_matches_the_preview_table`).

import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { formatOffset } from "../dialogs/csv-column-mapper/PreviewTable";
import { fixtureJson } from "./catalogGoldens";

type Row = { preview_us: string[] };

const table = fixtureJson<{ note: string; rows: Row[] }>("data/csvPreviewTimestamps.json");

describe("CSV preview timestamps", () => {
  it("matches the table's ts column", async () => {
    const rows = table.rows.map((row) => ({
      ...row,
      ts_preview: row.preview_us.map((us) => formatOffset(Number(us) / 1_000_000)),
    }));
    await expect(JSON.stringify({ ...table, rows }, null, 2) + "\n").toMatchFileSnapshot(
      resolve(__dirname, "fixtures/data/csvPreviewTimestamps.json"),
    );
  });
});

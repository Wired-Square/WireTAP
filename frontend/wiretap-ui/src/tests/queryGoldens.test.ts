// P5 D1: what the Query app sends, previews and exports today. The executed
// capture SQL beside the preview is `capturequery::tests` (`querySql.capture.json`);
// the bounds table's `rust` column is `payload_source::tests`.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.stubEnv("TZ", "Australia/Melbourne");

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { useQueryStore, type QueryParams, type QueryType, type QueuedQuery } from "../apps/query/stores/queryStore";
import { buildSqlPreview } from "../apps/query/views/QueryBuilderPanel";
import { buildQueryCsv } from "../apps/query/hooks/handlers/useQueryUIHandlers";
import type { TimeBounds } from "../components/TimeBoundsInput";
import { expectGolden, fixtureJson, type GoldenCase } from "./catalogGoldens";

const QUERY_TYPES: QueryType[] = [
  "byte_changes",
  "frame_changes",
  "mirror_validation",
  "mux_statistics",
  "first_last",
  "frequency",
  "distribution",
  "gap_analysis",
  "pattern_search",
  "frame_inventory",
];

const params: QueryParams = {
  frameId: 0x100,
  isExtended: null,
  byteIndex: 2,
  mirrorFrameId: 0x101,
  sourceFrameId: 0x100,
  toleranceMs: 50,
  muxSelectorByte: 0,
  include16Bit: true,
  payloadLength: 8,
  gapThresholdMs: 100,
  bucketSizeMs: 1000,
  pattern: [0xaa, 0xbb],
  patternMask: [0xff, 0x00],
};

const bounds = (startTime: string, endTime: string, timezoneMode: TimeBounds["timezoneMode"] = "local"): TimeBounds => ({
  startTime,
  endTime,
  timezoneMode,
});

const UNBOUNDED = bounds("", "");
const BOUNDED = bounds("2026-03-01T10:00", "2026-03-01T10:05");

type BoundsRow = {
  input: string;
  mode: TimeBounds["timezoneMode"];
  captureUs: number | null;
  captureInventory: string | null;
  gatewayIso: string | null;
};

type Source = { kind: "backend" | "capture"; id: string };
const SOURCES: Source[] = [
  { kind: "capture", id: "cap-1" },
  { kind: "backend", id: "profile-1" },
];

async function dispatch(
  queryType: QueryType,
  source: Source,
  timeBounds: TimeBounds | null,
  overrides: Partial<QueryParams> = {},
  catalogPath: string | null = null,
) {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "query_frame_inventory" ? [] : { results: [], stats: { rows_scanned: 0, results_count: 0, execution_time_ms: 0 } },
  );
  useQueryStore.setState({ queue: [], queryType, queryParams: { ...params, ...overrides }, catalogPath });
  const store = useQueryStore.getState();
  store.enqueueQuery(source.id, source.kind, timeBounds, 5000);
  await store.processNextQuery();
  const [item] = useQueryStore.getState().queue;
  return {
    calls: invoke.mock.calls.map(([cmd, args]) => ({ cmd, args: { ...args, queryId: args?.queryId ? "<id>" : undefined } })),
    queued: {
      displayName: item.displayName,
      profileId: item.profileId,
      captureId: item.captureId,
      timeBounds: item.timeBounds,
      resultLimit: item.resultLimit,
      status: item.status,
    },
  };
}

describe("query dispatch", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
  });
  afterAll(() => vi.useRealTimers());

  it("sends one command per type and source", async () => {
    const cases: GoldenCase[] = [];
    for (const source of SOURCES) {
      for (const queryType of QUERY_TYPES) {
        for (const [label, timeBounds] of [["unbounded", UNBOUNDED], ["bounded", BOUNDED]] as const) {
          const input = { queryType, source: source.kind, timeBounds, params: "default" };
          cases.push({ name: `${queryType} ${source.kind} ${label}`, input, expected: await dispatch(queryType, source, timeBounds) });
        }
      }
      for (const isExtended of [true, false]) {
        const input = { queryType: "byte_changes", source: source.kind, timeBounds: null, params: { isExtended } };
        cases.push({
          name: `byte_changes ${source.kind} isExtended ${isExtended}`,
          input,
          expected: await dispatch("byte_changes", source, null, { isExtended }),
        });
      }
      const input = { queryType: "mirror_validation", source: source.kind, timeBounds: null, catalogPath: "/catalogs/x.toml" };
      cases.push({
        name: `mirror_validation ${source.kind} with a catalogue`,
        input,
        expected: await dispatch("mirror_validation", source, null, {}, "/catalogs/x.toml"),
      });
      const empty = { pattern: [], patternMask: [] };
      cases.push({
        name: `pattern_search ${source.kind} empty pattern`,
        input: { queryType: "pattern_search", source: source.kind, params: empty },
        expected: await dispatch("pattern_search", source, null, empty),
      });
    }
    await expectGolden("queryDispatch.json", cases, "data");
  });

  it("encodes the time bounds per source", async () => {
    const { rows } = fixtureJson<{ rows: BoundsRow[] }>("data/queryBounds.json");
    for (const { input, mode, captureUs, captureInventory, gatewayIso } of rows) {
      const tb = bounds(input, "", mode);
      const sent = {
        captureUs: (await dispatch("byte_changes", SOURCES[0], tb)).calls[0].args.startTimeUs ?? null,
        captureInventory: (await dispatch("frame_inventory", SOURCES[0], tb)).calls[0].args.startTime ?? null,
        gatewayIso: (await dispatch("byte_changes", SOURCES[1], tb)).calls[0].args.startTime ?? null,
      };
      expect(sent, `${input} (${mode})`).toEqual({ captureUs, captureInventory, gatewayIso });
    }
  });
});

describe("SQL preview", () => {
  it("previews each type for each backend", async () => {
    const cases: GoldenCase[] = [];
    for (const isBufferSource of [true, false]) {
      for (const queryType of QUERY_TYPES) {
        for (const [label, timeBounds, isExtended] of [
          ["unbounded", UNBOUNDED, null],
          ["bounded", BOUNDED, true],
        ] as const) {
          const queryParams = { ...params, isExtended };
          cases.push({
            name: `${queryType} ${isBufferSource ? "capture" : "backend"} ${label}`,
            input: { queryType, isBufferSource, timeBounds, isExtended, limit: 5000 },
            expected: buildSqlPreview(queryType, queryParams, timeBounds, 5000, isBufferSource).split("\n"),
          });
        }
      }
    }
    await expectGolden("querySqlPreview.json", cases, "data");
  });
});

const RESULTS: Record<QueryType, QueuedQuery["results"]> = {
  byte_changes: [{ timestamp_us: 1_000_000, old_value: 0x0f, new_value: 0xa0 }],
  frame_changes: [{ timestamp_us: 1_000_000, old_payload: [1, 2, 3], new_payload: [1, 9, 3, 4], changed_indices: [1, 3] }],
  mirror_validation: [
    { mirror_timestamp_us: 1_000_100, source_timestamp_us: 1_000_000, mirror_payload: [1, 2], source_payload: [1, 3], mismatch_indices: [1] },
  ],
  mux_statistics: {
    mux_byte: 0,
    total_frames: 3,
    cases: [
      {
        mux_value: 1,
        frame_count: 3,
        byte_stats: [
          { byte_index: 1, min: 0, max: 255, avg: 85.3333, distinct_count: 3, sample_count: 3 },
          { byte_index: 2, min: 7, max: 7, avg: 7, distinct_count: 1, sample_count: 3 },
        ],
        word16_stats: [{ start_byte: 1, endianness: "le", min: 0, max: 1, avg: 0.5, distinct_count: 2 }],
      },
    ],
  },
  first_last: { first_timestamp_us: 1_000_000, first_payload: [0xde, 0xad], last_timestamp_us: 9_000_000, last_payload: [0xbe, 0xef], total_count: 42 },
  frequency: [{ bucket_start_us: 0, frame_count: 11, min_interval_us: 9_000, max_interval_us: 11_000, avg_interval_us: 10_000.456 }],
  distribution: [{ value: 0x0a, count: 2, percentage: 66.66666 }, { value: 0xff, count: 1, percentage: 33.33333 }],
  gap_analysis: [{ gap_start_us: 1_000_000, gap_end_us: 1_250_500, duration_ms: 250.5004 }],
  pattern_search: [{ timestamp_us: 1_000_000, frame_id: 0x18fef100, is_extended: true, payload: [0xaa, 0x00, 0xaa, 0x01], match_positions: [0, 2] }],
  frame_inventory: [
    { protocol: "can", frame_id: 0x100, frame_id_hex: "0x100", is_extended: false, count: 10, first_us: 1, last_us: 2, max_dlc: 8 },
    { protocol: "modbus_rtu", frame_id: 0x0103, frame_id_hex: "0x0103", is_extended: false, count: 1, first_us: 3, last_us: 3, max_dlc: 7 },
  ],
};

describe("query CSV", () => {
  it("shapes each type's results", async () => {
    const cases: GoldenCase[] = QUERY_TYPES.map((queryType) => {
      const query = { queryType, results: RESULTS[queryType] } as QueuedQuery;
      return { name: queryType, input: RESULTS[queryType], expected: buildQueryCsv(query)?.split("\n") ?? null };
    });
    await expectGolden("queryCsv.json", cases, "data");
  });
});

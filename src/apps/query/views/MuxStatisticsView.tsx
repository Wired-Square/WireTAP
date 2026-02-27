// src/apps/query/views/MuxStatisticsView.tsx
//
// Tabular display for mux statistics query results. Shows per-mux-case
// byte statistics and optional 16-bit word statistics.

import { useMemo } from "react";
import type {
  MuxStatisticsResult,
  MuxCaseStats,
  BytePositionStats,
  Word16Stats,
} from "../../../api/dbquery";
import type { QueryStats } from "../stores/queryStore";
import { monoBody } from "../../../styles/typography";
import { borderDivider, textPrimary, textSecondary, textMuted, textDataAmber, textDataGreen, textDataPurple } from "../../../styles/colourTokens";

interface Props {
  results: MuxStatisticsResult;
  stats: QueryStats | null;
  displayName: string;
}

/** Format a byte value as 2-digit hex */
function hex8(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, "0");
}

/** Format a 16-bit value as 4-digit hex */
function hex16(v: number): string {
  return v.toString(16).toUpperCase().padStart(4, "0");
}

/** Get colour class based on distinct count relative to sample count */
function distinctColour(distinct: number): string {
  if (distinct === 1) return textMuted;
  if (distinct <= 4) return textSecondary;
  return textDataGreen;
}

export default function MuxStatisticsView({ results, stats, displayName }: Props) {
  // Collect all byte indices that appear across cases
  const byteIndices = useMemo(() => {
    const indices = new Set<number>();
    for (const c of results.cases) {
      for (const bs of c.byte_stats) {
        indices.add(bs.byte_index);
      }
    }
    return Array.from(indices).sort((a, b) => a - b);
  }, [results]);

  // Collect 16-bit word pairs (LE only for column headers — BE is shown below)
  const has16Bit = results.cases.some((c) => c.word16_stats.length > 0);
  const wordPairs = useMemo(() => {
    if (!has16Bit) return [];
    const pairs = new Set<number>();
    for (const c of results.cases) {
      for (const ws of c.word16_stats) {
        if (ws.endianness === "le") pairs.add(ws.start_byte);
      }
    }
    return Array.from(pairs).sort((a, b) => a - b);
  }, [results, has16Bit]);

  // Helper: get byte stats for a case + byte index
  const getByteStats = (c: MuxCaseStats, idx: number): BytePositionStats | undefined =>
    c.byte_stats.find((bs) => bs.byte_index === idx);

  // Helper: get word stats for a case + start byte + endianness
  const getWordStats = (c: MuxCaseStats, startByte: number, endianness: "le" | "be"): Word16Stats | undefined =>
    c.word16_stats.find((ws) => ws.start_byte === startByte && ws.endianness === endianness);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className={`px-4 py-2 ${borderDivider}`}>
        <h2 className={`text-sm font-semibold ${textPrimary} truncate`}>
          {displayName}
        </h2>
        <p className={`text-xs ${textSecondary}`}>
          {results.cases.length} mux case{results.cases.length !== 1 ? "s" : ""},
          {" "}{results.total_frames.toLocaleString()} total frames
          {stats && (
            <span className={textMuted}>
              {" "}· {stats.rows_scanned.toLocaleString()} rows in {stats.execution_time_ms.toLocaleString()}ms
            </span>
          )}
        </p>
      </div>

      {/* Scrollable table area */}
      <div className="flex-1 overflow-auto p-4">
        {/* Byte Statistics Table */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={`${monoBody} text-xs ${textMuted} text-left px-2 py-1 sticky left-0 bg-[var(--bg-primary)] z-10`}>
                  Mux
                </th>
                <th className={`${monoBody} text-xs ${textMuted} text-right px-2 py-1`}>
                  Frames
                </th>
                {byteIndices.map((idx) => (
                  <th key={idx} className={`${monoBody} text-xs ${textMuted} text-center px-2 py-1 whitespace-nowrap`}>
                    B{idx}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.cases.map((c) => (
                <tr key={c.mux_value} className="border-t border-[var(--border-default)]">
                  <td className={`${monoBody} text-xs ${textDataAmber} px-2 py-1.5 font-semibold sticky left-0 bg-[var(--bg-primary)] z-10`}>
                    {c.mux_value}
                  </td>
                  <td className={`${monoBody} text-xs ${textSecondary} text-right px-2 py-1.5`}>
                    {c.frame_count.toLocaleString()}
                  </td>
                  {byteIndices.map((idx) => {
                    const bs = getByteStats(c, idx);
                    if (!bs) {
                      return <td key={idx} className={`${monoBody} text-xs ${textMuted} text-center px-2 py-1.5`}>—</td>;
                    }
                    const isStatic = bs.distinct_count === 1;
                    return (
                      <td
                        key={idx}
                        className={`${monoBody} text-xs text-center px-2 py-1.5 whitespace-nowrap`}
                        title={`avg: ${bs.avg.toFixed(1)}, distinct: ${bs.distinct_count}, samples: ${bs.sample_count}`}
                      >
                        <span className={distinctColour(bs.distinct_count)}>
                          {isStatic
                            ? hex8(bs.min)
                            : `${hex8(bs.min)}-${hex8(bs.max)}`}
                        </span>
                        <span className={`block text-xs ${textMuted}`}>
                          ({bs.distinct_count})
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 16-bit Word Statistics */}
        {has16Bit && wordPairs.length > 0 && (
          <div className="mt-6">
            <h3 className={`text-xs font-semibold ${textSecondary} mb-2`}>16-bit Word Statistics</h3>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={`${monoBody} text-xs ${textMuted} text-left px-2 py-1 sticky left-0 bg-[var(--bg-primary)] z-10`}>
                      Mux
                    </th>
                    {wordPairs.map((startByte) => (
                      <th key={startByte} colSpan={2} className={`${monoBody} text-xs ${textMuted} text-center px-2 py-1 whitespace-nowrap`}>
                        B{startByte}:B{startByte + 1}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    <th className={`sticky left-0 bg-[var(--bg-primary)] z-10`} />
                    {wordPairs.map((startByte) => (
                      <th key={startByte} colSpan={2} className={`${monoBody} text-xs ${textMuted} text-center px-1 py-0.5`}>
                        <span className={`inline-block w-1/2 ${textDataPurple}`}>LE</span>
                        <span className={`inline-block w-1/2 ${textDataGreen}`}>BE</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.cases.map((c) => (
                    <tr key={c.mux_value} className="border-t border-[var(--border-default)]">
                      <td className={`${monoBody} text-xs ${textDataAmber} px-2 py-1.5 font-semibold sticky left-0 bg-[var(--bg-primary)] z-10`}>
                        {c.mux_value}
                      </td>
                      {wordPairs.map((startByte) => {
                        const le = getWordStats(c, startByte, "le");
                        const be = getWordStats(c, startByte, "be");
                        return (
                          <td key={startByte} colSpan={2} className={`${monoBody} text-xs text-center px-2 py-1.5 whitespace-nowrap`}>
                            {le ? (
                              <div
                                className={distinctColour(le.distinct_count)}
                                title={`LE avg: ${le.avg.toFixed(1)}, distinct: ${le.distinct_count}`}
                              >
                                {le.distinct_count === 1
                                  ? hex16(le.min)
                                  : `${hex16(le.min)}-${hex16(le.max)}`}
                                <span className={`${textMuted}`}> ({le.distinct_count})</span>
                              </div>
                            ) : (
                              <div className={textMuted}>—</div>
                            )}
                            {be ? (
                              <div
                                className={distinctColour(be.distinct_count)}
                                title={`BE avg: ${be.avg.toFixed(1)}, distinct: ${be.distinct_count}`}
                              >
                                {be.distinct_count === 1
                                  ? hex16(be.min)
                                  : `${hex16(be.min)}-${hex16(be.max)}`}
                                <span className={`${textMuted}`}> ({be.distinct_count})</span>
                              </div>
                            ) : (
                              <div className={textMuted}>—</div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

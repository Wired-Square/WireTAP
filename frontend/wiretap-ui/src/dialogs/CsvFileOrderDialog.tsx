// ui/src/dialogs/CsvFileOrderDialog.tsx
//
// Dialog for confirming the import order of multiple CSV/data files.
// Natural sort by default; reorder via drag-and-drop or arrow buttons.
// Auto-detects headers per file and validates column count consistency.

import { useState, useCallback, useMemo, useEffect } from "react";
import {
  ChevronUp,
  ChevronDown,
  Loader2,
  GripVertical,
  AlertTriangle,
  Trash2,
} from "lucide-react";
import Dialog from "../components/Dialog";
import ContextMenu, { type ContextMenuItem } from "../components/ContextMenu";
import { DialogFooter } from "../components/forms/DialogFooter";
import { previewCsv } from "../api/capture";
import {
  h3,
  cardElevated,
  paddingCard,
  caption,
  textMuted,
  textSecondary,
  bgSurface,
  borderDefault,
  iconButtonHover,
} from "../styles";
import { iconSm, iconMd } from "../styles/spacing";

export type CsvFileOrderDialogProps = {
  isOpen: boolean;
  filePaths: string[];
  onConfirm: (orderedPaths: string[], hasHeaderPerFile: boolean[]) => void;
  onCancel: () => void;
};

/** Natural sort comparator — handles numbered filenames correctly */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Extract filename from a full path */
function extractFilename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Truncate in the middle, keeping prefix and suffix visible */
function truncateMiddle(name: string, maxLen = 50): string {
  if (name.length <= maxLen) return name;
  const keep = Math.floor((maxLen - 1) / 2);
  return name.slice(0, keep) + "\u2026" + name.slice(name.length - keep);
}

interface FileEntry {
  path: string;
  hasHeader: boolean;
  detecting: boolean;
  columnCount: number | null;
  headerStrings: string[] | null;
}

/** Build per-file anomaly warnings by comparing against the first file */
function getAnomalies(entries: FileEntry[]): (string | null)[] {
  if (entries.length === 0) return [];
  const ref = entries[0];
  return entries.map((entry, i) => {
    if (i === 0 || entry.detecting) return null;
    const warnings: string[] = [];

    // Column count mismatch
    if (
      ref.columnCount !== null &&
      entry.columnCount !== null &&
      entry.columnCount !== ref.columnCount
    ) {
      warnings.push(
        `Expected ${ref.columnCount} columns, found ${entry.columnCount}`
      );
    }

    // Header differs from first file
    if (
      entry.hasHeader &&
      ref.headerStrings !== null &&
      entry.headerStrings !== null
    ) {
      const same =
        ref.headerStrings.length === entry.headerStrings.length &&
        ref.headerStrings.every((h, idx) => h === entry.headerStrings![idx]);
      if (!same) {
        warnings.push("Header differs from first file");
      }
    }

    return warnings.length > 0 ? warnings.join("\n") : null;
  });
}

export default function CsvFileOrderDialog({
  isOpen,
  filePaths,
  onConfirm,
  onCancel,
}: CsvFileOrderDialogProps) {
  // Sort naturally on first render
  const sortedPaths = useMemo(
    () =>
      [...filePaths].sort((a, b) =>
        naturalCompare(extractFilename(a), extractFilename(b))
      ),
    [filePaths]
  );

  const [entries, setEntries] = useState<FileEntry[]>(() =>
    sortedPaths.map((path) => ({
      path,
      hasHeader: true,
      detecting: true,
      columnCount: null,
      headerStrings: null,
    }))
  );

  // Drag-and-drop state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  /** Insertion point: the dragged item will be placed BEFORE this index. null = no indicator. */
  const [dropInsertIndex, setDropInsertIndex] = useState<number | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    index: number;
  } | null>(null);

  // Auto-detect headers and column counts for each file
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const initial: FileEntry[] = sortedPaths.map((path) => ({
      path,
      hasHeader: true,
      detecting: true,
      columnCount: null,
      headerStrings: null,
    }));
    setEntries(initial);

    sortedPaths.forEach((path, i) => {
      previewCsv(path, 5)
        .then((preview) => {
          if (cancelled) return;
          // Column count from first data row (or header if present)
          const colCount =
            preview.headers?.length ??
            (preview.rows[0]?.length ?? null);
          setEntries((prev) =>
            prev.map((e, idx) =>
              idx === i
                ? {
                    ...e,
                    hasHeader: preview.has_header,
                    detecting: false,
                    columnCount: colCount,
                    headerStrings: preview.has_header
                      ? (preview.headers ?? null)
                      : null,
                  }
                : e
            )
          );
        })
        .catch(() => {
          if (cancelled) return;
          setEntries((prev) =>
            prev.map((e, idx) =>
              idx === i
                ? {
                    ...e,
                    hasHeader: false,
                    detecting: false,
                    columnCount: null,
                    headerStrings: null,
                  }
                : e
            )
          );
        });
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, sortedPaths]);

  // --- Reorder helpers ---

  const moveUp = useCallback((index: number) => {
    if (index <= 0) return;
    setEntries((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }, []);

  const moveDown = useCallback((index: number) => {
    setEntries((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }, []);

  /** Compute the insertion index from a dragOver event on a row */
  const calcInsertIndex = useCallback(
    (e: React.DragEvent, rowIndex: number) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      // If cursor is in the top half → insert before this row, else after
      return e.clientY < midY ? rowIndex : rowIndex + 1;
    },
    []
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (dragIndex !== null && dropInsertIndex !== null) {
        // Adjust target: if dragging downward, removing the source shifts indices
        let target = dropInsertIndex;
        if (target > dragIndex) target -= 1;
        if (target !== dragIndex) {
          setEntries((prev) => {
            const next = [...prev];
            const [moved] = next.splice(dragIndex, 1);
            next.splice(target, 0, moved);
            return next;
          });
        }
      }
      setDragIndex(null);
      setDropInsertIndex(null);
    },
    [dragIndex, dropInsertIndex]
  );

  const toggleHeader = useCallback((index: number) => {
    setEntries((prev) =>
      prev.map((e, i) => (i === index ? { ...e, hasHeader: !e.hasHeader } : e))
    );
  }, []);

  const removeEntry = useCallback((index: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.preventDefault();
      setContextMenu({ position: { x: e.clientX, y: e.clientY }, index });
    },
    []
  );

  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (contextMenu === null) return [];
    const idx = contextMenu.index;
    return [
      {
        label: "Remove from list",
        icon: <Trash2 className={`${iconSm} text-[color:var(--text-muted)]`} />,
        onClick: () => removeEntry(idx),
      },
    ];
  }, [contextMenu, removeEntry]);

  const detecting = entries.some((e) => e.detecting);
  const anomalies = useMemo(() => getAnomalies(entries), [entries]);

  return (
    <>
    <Dialog isOpen={isOpen} onBackdropClick={onCancel} maxWidth="max-w-4xl">
      <div className={`${cardElevated} ${paddingCard} space-y-4`}>
        <div>
          <h3 className={h3}>Confirm File Order</h3>
          <p className={caption}>
            {entries.length} files selected. Files will be imported sequentially
            into a single buffer.
          </p>
        </div>

        {/* File list */}
        <div
          className={`border ${borderDefault} rounded overflow-y-auto`}
          style={{ maxHeight: "24rem" }}
          onDragLeave={(e) => {
            // Clear indicator when cursor leaves the list container entirely
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDropInsertIndex(null);
            }
          }}
        >
          {/* Column headers */}
          <div
            className={`flex items-center gap-2 px-3 py-1 ${bgSurface} border-b ${borderDefault}`}
          >
            <span className="w-5 shrink-0" />
            <span className="w-5 shrink-0" />
            <span
              className={`${textMuted} text-[10px] uppercase tracking-wider flex-1 min-w-0`}
            >
              File
            </span>
            <span
              className={`${textMuted} text-[10px] uppercase tracking-wider w-14 text-center`}
            >
              Header
            </span>
            <span className="w-4 shrink-0" />
            <span className="w-14 shrink-0" />
          </div>

          {entries.map((entry, i) => {
            const fname = extractFilename(entry.path);
            const anomaly = anomalies[i];
            const showLineBefore =
              dragIndex !== null && dropInsertIndex === i && dropInsertIndex !== dragIndex && dropInsertIndex !== dragIndex + 1;
            const showLineAfter =
              dragIndex !== null &&
              i === entries.length - 1 &&
              dropInsertIndex === entries.length &&
              dropInsertIndex !== dragIndex &&
              dropInsertIndex !== dragIndex + 1;

            return (
              <div key={entry.path} className="relative">
                {/* Drop insertion line — before this row */}
                {showLineBefore && (
                  <div className="absolute top-0 left-2 right-2 h-0.5 bg-white rounded-full z-10 -translate-y-px" />
                )}

                <div
                  onContextMenu={(e) => handleContextMenu(e, i)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDropInsertIndex(calcInsertIndex(e, i));
                  }}
                  onDragLeave={() => setDropInsertIndex(null)}
                  onDrop={handleDrop}
                  className={`flex items-center gap-2 px-3 py-1.5 ${
                    i > 0 ? `border-t ${borderDefault}` : ""
                  } ${bgSurface} ${dragIndex === i ? "opacity-30" : ""}`}
                >
                  {/* Drag handle */}
                  <div
                    draggable
                    onDragStart={(e) => {
                      setDragIndex(i);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      setDragIndex(null);
                      setDropInsertIndex(null);
                    }}
                    className="cursor-grab active:cursor-grabbing shrink-0"
                    title="Drag to reorder"
                  >
                    <GripVertical
                      className={`${iconSm} text-[color:var(--text-muted)]`}
                    />
                  </div>

                {/* Index */}
                <span
                  className={`${textMuted} text-xs tabular-nums w-5 text-right shrink-0`}
                >
                  {i + 1}
                </span>

                {/* Filename — middle-truncated with full-name tooltip */}
                <span
                  className={`${textSecondary} text-xs flex-1 min-w-0`}
                  title={fname}
                >
                  {truncateMiddle(fname)}
                </span>

                {/* Header checkbox */}
                <div className="w-14 flex justify-center shrink-0">
                  {entry.detecting ? (
                    <Loader2
                      className={`${iconSm} animate-spin ${textMuted}`}
                    />
                  ) : (
                    <input
                      type="checkbox"
                      checked={entry.hasHeader}
                      onChange={() => toggleHeader(i)}
                      className="accent-blue-500"
                      title={
                        entry.hasHeader
                          ? "First row is a header"
                          : "No header row"
                      }
                    />
                  )}
                </div>

                {/* Anomaly indicator */}
                <div className="w-4 shrink-0 flex justify-center">
                  {anomaly && (
                    <span title={anomaly}>
                      <AlertTriangle
                        className={`${iconSm} text-amber-500`}
                      />
                    </span>
                  )}
                </div>

                {/* Reorder buttons */}
                <div className="flex gap-0.5 w-14 shrink-0 justify-end">
                  <button
                    type="button"
                    onClick={() => moveUp(i)}
                    disabled={i === 0}
                    className={`${iconButtonHover} p-0.5 rounded disabled:opacity-20`}
                    title="Move up"
                  >
                    <ChevronUp className={iconSm} />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveDown(i)}
                    disabled={i === entries.length - 1}
                    className={`${iconButtonHover} p-0.5 rounded disabled:opacity-20`}
                    title="Move down"
                  >
                    <ChevronDown className={iconSm} />
                  </button>
                </div>
              </div>

                {/* Drop insertion line — after last row */}
                {showLineAfter && (
                  <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-white rounded-full z-10 translate-y-px" />
                )}
              </div>
            );
          })}
        </div>

        {detecting && (
          <div className={`flex items-center gap-2 text-xs ${textMuted}`}>
            <Loader2 className={`${iconMd} animate-spin`} />
            <span>Detecting headers...</span>
          </div>
        )}

        <DialogFooter
          onCancel={onCancel}
          onConfirm={() =>
            onConfirm(
              entries.map((e) => e.path),
              entries.map((e) => e.hasHeader)
            )
          }
          confirmLabel="Next: Map Columns"
          confirmDisabled={detecting || entries.length === 0}
        />
      </div>
    </Dialog>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}

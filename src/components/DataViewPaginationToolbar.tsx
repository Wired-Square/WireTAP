// ui/src/components/DataViewPaginationToolbar.tsx
//
// Shared pagination toolbar for data views (Discovery, Decoder, etc.).
//
// Layout: [left + center] — [info + page-counter + page-nav] — [right + page-size]
// This three-zone layout keeps buttons stable on the left and selectors on the right,
// with informational displays (frame counter, page counter) centered between them.

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { iconSm } from "../styles/spacing";
import {
  bgDataToolbar,
  borderDataView,
  bgDataInput,
  textDataPrimary,
  textDataSecondary,
  gapDefault,
} from "../styles";
import { paginationButtonDark } from "../styles/buttonStyles";

export interface PageSizeOption {
  value: number;
  label: string;
}

interface DataViewPaginationToolbarProps {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  pageSizeOptions: PageSizeOption[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  /** @deprecated No longer rendered — kept for backward compatibility */
  isLoading?: boolean;
  disabled?: boolean;
  /** Additional content to show on the left side of the toolbar (e.g., time range inputs) */
  leftContent?: React.ReactNode;
  /** Content to show after leftContent (e.g., playback transport buttons) */
  centerContent?: React.ReactNode;
  /** Informational content for the center zone (e.g., frame counter) */
  infoContent?: React.ReactNode;
  /** Content for the right zone, before the page size selector (e.g., speed selector) */
  rightContent?: React.ReactNode;
  /** Hide pagination buttons (still shows page size selector) */
  hidePagination?: boolean;
  /** Hide page size selector (use when pagination is not applicable at all) */
  hidePageSize?: boolean;
}

/** Standard page size options for frame-based views */
export const FRAME_PAGE_SIZE_OPTIONS: PageSizeOption[] = [
  { value: 20, label: "20" },
  { value: 50, label: "50" },
  { value: 100, label: "100" },
];

/** Page size options for byte-based views (ByteView) */
export const BYTE_PAGE_SIZE_OPTIONS: PageSizeOption[] = [
  { value: 100, label: "100" },
  { value: 500, label: "500" },
  { value: 1000, label: "1000" },
  { value: 5000, label: "5000" },
  { value: 10000, label: "10000" },
];

export default function DataViewPaginationToolbar({
  currentPage,
  totalPages,
  pageSize,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
  isLoading: _isLoading = false,
  disabled = false,
  leftContent,
  centerContent,
  infoContent,
  rightContent,
  hidePagination = false,
  hidePageSize = false,
}: DataViewPaginationToolbarProps) {
  const showPagination = !hidePagination && totalPages > 1 && pageSize !== -1;

  return (
    <div className={`flex-shrink-0 px-3 py-2 border-b ${borderDataView} ${bgDataToolbar} flex items-center ${gapDefault}`}>
      {/* LEFT ZONE: content slots */}
      {leftContent}
      {centerContent}

      <div className="flex-1" />

      {/* CENTER ZONE: info displays + page navigation */}
      {infoContent}

      {showPagination && (
        <div className="flex items-center gap-0.5">
          <span className={`text-xs ${textDataSecondary} px-1 tabular-nums`}>
            {currentPage + 1} / {totalPages}
          </span>
          <button
            onClick={() => onPageChange(0)}
            disabled={disabled || currentPage === 0}
            className={paginationButtonDark}
            title="First page"
          >
            <ChevronsLeft className={iconSm} />
          </button>
          <button
            onClick={() => onPageChange(Math.max(0, currentPage - 1))}
            disabled={disabled || currentPage === 0}
            className={paginationButtonDark}
            title="Previous page"
          >
            <ChevronLeft className={iconSm} />
          </button>
          <button
            onClick={() => onPageChange(Math.min(totalPages - 1, currentPage + 1))}
            disabled={disabled || currentPage >= totalPages - 1}
            className={paginationButtonDark}
            title="Next page"
          >
            <ChevronRight className={iconSm} />
          </button>
          <button
            onClick={() => onPageChange(totalPages - 1)}
            disabled={disabled || currentPage >= totalPages - 1}
            className={paginationButtonDark}
            title="Last page"
          >
            <ChevronsRight className={iconSm} />
          </button>
        </div>
      )}

      <div className="flex-1" />

      {/* RIGHT ZONE: selectors */}
      {rightContent}

      {!hidePageSize && (
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className={`text-xs px-2 py-1 rounded border border-gray-600 ${bgDataInput} ${textDataPrimary}`}
          title="Rows per page"
        >
          {pageSizeOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

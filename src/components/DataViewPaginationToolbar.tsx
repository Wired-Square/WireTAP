// ui/src/components/DataViewPaginationToolbar.tsx
//
// Shared pagination toolbar for data views (Discovery, Decoder, etc.).

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2 } from "lucide-react";
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
  isLoading?: boolean;
  disabled?: boolean;
  /** Additional content to show on the left side of the toolbar */
  leftContent?: React.ReactNode;
  /** Additional content to show before the pagination controls */
  centerContent?: React.ReactNode;
  /** Hide pagination buttons (still shows page size selector) */
  hidePagination?: boolean;
}

/** Standard page size options for frame-based views */
export const FRAME_PAGE_SIZE_OPTIONS: PageSizeOption[] = [
  { value: 20, label: "20" },
  { value: 50, label: "50" },
  { value: 100, label: "100" },
  { value: 1000, label: "1000" },
  { value: 10000, label: "10000" },
  { value: -1, label: "All" },
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
  isLoading = false,
  disabled = false,
  leftContent,
  centerContent,
  hidePagination = false,
}: DataViewPaginationToolbarProps) {
  const showPagination = !hidePagination && totalPages > 1 && pageSize !== -1;

  return (
    <div className={`flex-shrink-0 px-3 py-2 border-b ${borderDataView} ${bgDataToolbar} flex items-center ${gapDefault}`}>
      {/* Left content slot */}
      {leftContent}

      <div className="flex-1" />

      {/* Center content slot */}
      {centerContent}

      {/* Loading indicator */}
      {isLoading && (
        <div className="flex items-center gap-1">
          <Loader2 className={`${iconSm} animate-spin ${textDataSecondary}`} />
          <span className={`text-xs ${textDataSecondary}`}>Loading...</span>
        </div>
      )}

      {/* Pagination controls - to the left of page size selector */}
      {showPagination && !isLoading && (
        <div className="flex items-center gap-0.5">
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
          <span className={`text-xs ${textDataSecondary} px-1`}>
            {currentPage + 1} / {totalPages}
          </span>
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

      {/* Page size selector - at the extreme right */}
      <select
        value={pageSize}
        onChange={(e) => onPageSizeChange(Number(e.target.value))}
        disabled={disabled}
        className={`text-xs px-2 py-1 rounded border border-gray-600 ${bgDataInput} ${textDataPrimary} disabled:opacity-50`}
        title="Rows per page"
      >
        {pageSizeOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

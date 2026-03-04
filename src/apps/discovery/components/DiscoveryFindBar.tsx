// ui/src/apps/discovery/components/DiscoveryFindBar.tsx

import { useEffect, useRef } from "react";
import { X, ChevronUp, ChevronDown, Loader } from "lucide-react";
import { iconMd, iconXs } from "../../../styles/spacing";
import { disabledState, borderDivider, focusRing, iconButtonHoverSmall } from "../../../styles";

export type FindSearchMode = 'id' | 'data' | 'both';

type Props = {
  query: string;
  onQueryChange: (q: string) => void;
  matchCount: number;
  currentIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  searchMode: FindSearchMode;
  onSearchModeChange: (mode: FindSearchMode) => void;
  isSearching: boolean;
};

const MODES: { key: FindSearchMode; label: string }[] = [
  { key: 'both', label: 'Both' },
  { key: 'id',   label: 'ID' },
  { key: 'data', label: 'Data' },
];

export default function DiscoveryFindBar({
  query,
  onQueryChange,
  matchCount,
  currentIndex,
  onNext,
  onPrev,
  onClose,
  searchMode,
  onSearchModeChange,
  isSearching,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter") {
      if (e.shiftKey) {
        onPrev();
      } else {
        onNext();
      }
    }
  };

  const counterText = isSearching
    ? ""
    : query.replace(/\s/g, '')
      ? matchCount > 0
        ? `${currentIndex + 1}/${matchCount}`
        : "No results"
      : "";

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-surface)] ${borderDivider}`}>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in frames…"
        className={`w-48 px-2.5 py-1 text-sm rounded-md border border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-primary)] ${focusRing}`}
      />

      {/* Mode toggle */}
      <div className="flex items-center rounded border border-[color:var(--border-default)] overflow-hidden text-xs">
        {MODES.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => onSearchModeChange(key)}
            className={`px-2 py-1 transition-colors ${
              searchMode === key
                ? 'bg-gray-600 text-white'
                : 'bg-[var(--bg-primary)] text-[color:var(--text-secondary)] hover:brightness-95'
            }`}
            title={`Search ${label === 'Both' ? 'ID and Data' : label} column${label === 'Both' ? 's' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Match counter / spinner */}
      <span className="text-sm text-[color:var(--text-muted)] min-w-[60px] text-center flex items-center justify-center gap-1">
        {isSearching
          ? <Loader className={`${iconXs} animate-spin`} />
          : counterText}
      </span>

      <button
        onClick={onPrev}
        disabled={matchCount === 0 || isSearching}
        className={`${iconButtonHoverSmall} ${disabledState}`}
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp className={iconMd} />
      </button>

      <button
        onClick={onNext}
        disabled={matchCount === 0 || isSearching}
        className={`${iconButtonHoverSmall} ${disabledState}`}
        title="Next match (Enter)"
      >
        <ChevronDown className={iconMd} />
      </button>

      <button
        onClick={onClose}
        className={iconButtonHoverSmall}
        title="Close (Escape)"
      >
        <X className={iconMd} />
      </button>
    </div>
  );
}

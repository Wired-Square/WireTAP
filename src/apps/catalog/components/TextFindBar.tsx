// ui/src/apps/catalog/components/TextFindBar.tsx

import { useEffect, useRef, useCallback } from "react";
import { X, ChevronUp, ChevronDown } from "lucide-react";
import { iconMd } from "../../../styles/spacing";
import { disabledState, borderDivider, focusRing, iconButtonHoverSmall } from "../../../styles";
import { useCatalogEditorStore } from "../../../stores/catalogEditorStore";

export type TextFindBarProps = {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
};

/**
 * Find all case-insensitive matches in text and return their positions.
 */
function findAllMatches(text: string, query: string): number[] {
  if (!query) return [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const positions: number[] = [];
  let pos = 0;
  while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
    positions.push(pos);
    pos += 1; // Move past current match to find overlapping matches
  }
  return positions;
}

export default function TextFindBar({ textareaRef }: TextFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const matchPositionsRef = useRef<number[]>([]);

  // Store state
  const textFind = useCatalogEditorStore((s) => s.ui.textFind);
  const toml = useCatalogEditorStore((s) => s.content.toml);

  // Store actions
  const closeTextFind = useCatalogEditorStore((s) => s.closeTextFind);
  const setTextFindQuery = useCatalogEditorStore((s) => s.setTextFindQuery);
  const setTextFindMatchCount = useCatalogEditorStore((s) => s.setTextFindMatchCount);
  const textFindNext = useCatalogEditorStore((s) => s.textFindNext);
  const textFindPrevious = useCatalogEditorStore((s) => s.textFindPrevious);

  // Focus input when opened
  useEffect(() => {
    if (textFind.isOpen && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [textFind.isOpen]);

  // Update matches when query or content changes
  useEffect(() => {
    if (!textFind.query.trim()) {
      matchPositionsRef.current = [];
      setTextFindMatchCount(0);
      return;
    }

    const positions = findAllMatches(toml, textFind.query.trim());
    matchPositionsRef.current = positions;
    setTextFindMatchCount(positions.length);
  }, [textFind.query, toml, setTextFindMatchCount]);

  // Navigate to current match in textarea
  const navigateToMatch = useCallback(
    (index: number) => {
      const positions = matchPositionsRef.current;
      if (index < 0 || index >= positions.length) return;
      if (!textareaRef.current) return;

      const pos = positions[index];
      const queryLen = textFind.query.length;

      // Set selection in textarea
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(pos, pos + queryLen);

      // Scroll to make selection visible
      // Calculate approximate line number and scroll
      const textBefore = toml.substring(0, pos);
      const lineNumber = textBefore.split('\n').length;
      const lineHeight = 20; // approximate line height in pixels
      const scrollTop = Math.max(0, (lineNumber - 5) * lineHeight);
      textareaRef.current.scrollTop = scrollTop;
    },
    [textFind.query, toml, textareaRef]
  );

  // Navigate when currentIndex changes
  useEffect(() => {
    if (textFind.currentIndex >= 0) {
      navigateToMatch(textFind.currentIndex);
    }
  }, [textFind.currentIndex, navigateToMatch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      closeTextFind();
    } else if (e.key === "Enter") {
      if (e.shiftKey) {
        textFindPrevious();
      } else {
        textFindNext();
      }
    }
  };

  if (!textFind.isOpen) return null;

  const matchCount = textFind.matchCount;
  const currentMatch = textFind.currentIndex + 1;

  return (
    <div className={`flex items-center gap-2 px-4 py-2 bg-[var(--bg-surface)] ${borderDivider}`}>
      <input
        ref={inputRef}
        type="text"
        value={textFind.query}
        onChange={(e) => setTextFindQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in text..."
        className={`flex-1 px-3 py-1.5 text-sm rounded-md border border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-primary)] ${focusRing}`}
      />

      <span className="text-sm text-[color:var(--text-muted)] min-w-[60px] text-center">
        {textFind.query.trim()
          ? matchCount > 0
            ? textFind.currentIndex >= 0
              ? `${currentMatch}/${matchCount}`
              : `${matchCount} found`
            : "No results"
          : ""}
      </span>

      <button
        onClick={textFindPrevious}
        disabled={matchCount === 0}
        className={`${iconButtonHoverSmall} ${disabledState}`}
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp className={iconMd} />
      </button>

      <button
        onClick={textFindNext}
        disabled={matchCount === 0}
        className={`${iconButtonHoverSmall} ${disabledState}`}
        title="Next match (Enter)"
      >
        <ChevronDown className={iconMd} />
      </button>

      <button
        onClick={closeTextFind}
        className={iconButtonHoverSmall}
        title="Close (Escape)"
      >
        <X className={iconMd} />
      </button>
    </div>
  );
}

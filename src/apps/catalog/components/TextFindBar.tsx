// ui/src/apps/catalog/components/TextFindBar.tsx

import { useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("common");
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

      const ta = textareaRef.current;
      const pos = positions[index];
      const queryLen = textFind.query.length;

      // Set selection in textarea
      ta.focus();
      ta.setSelectionRange(pos, pos + queryLen);

      // Scroll the match into view only if it's outside the current viewport.
      // Derive the real line height and top padding from the live element so
      // the maths matches the rendered textarea (leading-[1.5rem] = 24px, p-4 = 16px).
      const style = getComputedStyle(ta);
      const lineHeight = parseFloat(style.lineHeight) || 24;
      const padTop = parseFloat(style.paddingTop) || 0;

      const lineIndex = toml.substring(0, pos).split("\n").length - 1; // 0-based
      const margin = lineHeight * 2; // keep a couple of lines of context
      const top = padTop + lineIndex * lineHeight;
      const bottom = top + lineHeight;

      if (top - margin < ta.scrollTop) {
        ta.scrollTop = Math.max(0, top - margin);
      } else if (bottom + margin > ta.scrollTop + ta.clientHeight) {
        ta.scrollTop = bottom + margin - ta.clientHeight;
      }
      // else: already visible — leave scroll untouched
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
        placeholder={t("findBar.placeholderText")}
        className={`flex-1 px-3 py-1.5 text-sm rounded-md border border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-primary)] ${focusRing}`}
      />

      <span className="text-sm text-[color:var(--text-muted)] min-w-[60px] text-center">
        {textFind.query.trim()
          ? matchCount > 0
            ? textFind.currentIndex >= 0
              ? t("findBar.currentOfTotal", { current: currentMatch, total: matchCount })
              : t("findBar.matchesFound", { count: matchCount })
            : t("findBar.noResults")
          : ""}
      </span>

      <button
        onClick={textFindPrevious}
        disabled={matchCount === 0}
        className={`${iconButtonHoverSmall} ${disabledState}`}
        title={t("findBar.previous")}
      >
        <ChevronUp className={iconMd} />
      </button>

      <button
        onClick={textFindNext}
        disabled={matchCount === 0}
        className={`${iconButtonHoverSmall} ${disabledState}`}
        title={t("findBar.next")}
      >
        <ChevronDown className={iconMd} />
      </button>

      <button
        onClick={closeTextFind}
        className={iconButtonHoverSmall}
        title={t("findBar.close")}
      >
        <X className={iconMd} />
      </button>
    </div>
  );
}

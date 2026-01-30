// ui/src/apps/catalog/views/TextModeView.tsx

import { forwardRef, useRef, useEffect, useCallback, useState } from "react";

export type TextModeViewProps = {
  toml: string;
  onChangeToml: (next: string) => void;
  placeholder?: string;
  isDisabled?: boolean;
};

const TextModeView = forwardRef<HTMLTextAreaElement, TextModeViewProps>(
  ({ toml, onChangeToml, placeholder, isDisabled }, ref) => {
    const lineNumbersRef = useRef<HTMLDivElement>(null);
    const [lineCount, setLineCount] = useState(1);

    // Update line count when content changes
    useEffect(() => {
      const lines = toml.split("\n").length;
      setLineCount(Math.max(1, lines));
    }, [toml]);

    // Sync scroll between textarea and line numbers
    const handleScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
      if (lineNumbersRef.current) {
        lineNumbersRef.current.scrollTop = e.currentTarget.scrollTop;
      }
    }, []);

    // Generate line numbers
    const lineNumbers = Array.from({ length: lineCount }, (_, i) => i + 1);

    return (
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Line numbers gutter */}
        <div
          ref={lineNumbersRef}
          className="flex-shrink-0 py-4 pr-3 pl-4 font-mono text-sm text-right text-[color:var(--text-muted)] bg-[var(--bg-surface)] border-r border-[color:var(--border-default)] select-none overflow-hidden"
          style={{ minWidth: `${Math.max(3, String(lineCount).length + 1)}ch` }}
          aria-hidden="true"
        >
          {lineNumbers.map((num) => (
            <div key={num} className="leading-[1.5rem]">
              {num}
            </div>
          ))}
        </div>

        {/* Textarea */}
        <textarea
          ref={ref}
          value={toml}
          onChange={(e) => onChangeToml(e.target.value)}
          onScroll={handleScroll}
          disabled={isDisabled}
          className="flex-1 p-4 font-mono text-sm leading-[1.5rem] bg-[var(--bg-primary)] text-[color:var(--text-primary)] resize-none focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed"
          placeholder={placeholder || "Open a catalog file to edit..."}
          spellCheck={false}
        />
      </div>
    );
  }
);

TextModeView.displayName = "TextModeView";

export default TextModeView;

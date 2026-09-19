// Copyright 2026 Wired Square Pty Ltd

import { useState, useRef, useEffect } from "react";
import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { Input } from "../../../components/forms";

interface InlineEditProps {
  value: string;
  placeholder?: string;
  variant?: "primary" | "secondary";
  onCommit: (value: string) => void;
}

export function InlineEdit({ value, placeholder, variant = "primary", onCommit }: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    setEditing(false);
    if (draft !== value) {
      onCommit(draft);
    }
  };

  const cancel = () => {
    setEditing(false);
    setDraft(value);
  };

  if (editing) {
    return (
      <Input
        ref={inputRef}
        size="lg"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") cancel();
        }}
      />
    );
  }

  const textClass = variant === "primary" ? `text-sm font-medium ${textPrimary}` : `text-xs ${textSecondary}`;
  const displayValue = value || placeholder;

  return (
    <span
      className={`${displayValue === placeholder ? textTertiary : textClass} cursor-pointer hover:underline hover:decoration-dotted`}
      onClick={() => setEditing(true)}
    >
      {displayValue}
    </span>
  );
}

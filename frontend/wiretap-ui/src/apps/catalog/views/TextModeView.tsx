// ui/src/apps/catalog/views/TextModeView.tsx

import { forwardRef } from "react";
import CodeView from "../../../components/CodeView";

export type TextModeViewProps = {
  toml: string;
  onChangeToml: (next: string) => void;
  placeholder?: string;
  isDisabled?: boolean;
};

const TextModeView = forwardRef<HTMLTextAreaElement, TextModeViewProps>(
  ({ toml, onChangeToml, placeholder, isDisabled }, ref) => (
    <CodeView
      ref={ref}
      content={toml}
      onChange={onChangeToml}
      placeholder={placeholder}
      isDisabled={isDisabled}
    />
  )
);

TextModeView.displayName = "TextModeView";

export default TextModeView;

// ui/src/apps/graph/widgets/WidgetEmpty.tsx
//
// Shared empty-state for widgets ("add a signal", "configure …").

import { emptyStateContainer, emptyStateText } from "../../../styles/typography";

export default function WidgetEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className={emptyStateContainer}>
      <p className={emptyStateText}>{children}</p>
    </div>
  );
}

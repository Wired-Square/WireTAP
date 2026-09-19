// ui/src/apps/dashboard/widgets/WidgetError.tsx
//
// Non-fatal error overlay for custom widgets (compile/draw/timeout messages).

import { Alert } from "../../../components/Alert";

export default function WidgetError({ children }: { children: React.ReactNode }) {
  return (
    <Alert tone="danger" size="sm" banner className="absolute inset-x-0 bottom-0 font-mono">
      <span className="block truncate">{children}</span>
    </Alert>
  );
}

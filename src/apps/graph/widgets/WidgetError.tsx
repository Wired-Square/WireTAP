// ui/src/apps/graph/widgets/WidgetError.tsx
//
// Non-fatal error overlay for custom widgets (compile/draw/timeout messages).

export default function WidgetError({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-x-0 bottom-0 px-2 py-1 text-[10px] font-mono text-red-300 bg-red-950/70 truncate">
      {children}
    </div>
  );
}

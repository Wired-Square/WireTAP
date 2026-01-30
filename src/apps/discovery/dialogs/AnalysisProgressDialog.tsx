// ui/src/apps/discovery/dialogs/AnalysisProgressDialog.tsx

import { Loader2 } from "lucide-react";
import Dialog from "../../../components/Dialog";
import { bgSecondary, captionMuted } from "../../../styles";

export interface AnalysisProgressDialogProps {
  isOpen: boolean;
  frameCount: number;
  toolName: string;
}

export default function AnalysisProgressDialog({
  isOpen,
  frameCount,
  toolName,
}: AnalysisProgressDialogProps) {
  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-sm">
      <div className="p-6 text-center">
        {/* Animated loader */}
        <div className="mb-4">
          <Loader2 className="w-12 h-12 mx-auto text-[color:var(--accent-secondary)] animate-spin" />
        </div>

        {/* Title */}
        <h2 className="text-lg font-semibold text-[color:var(--text-primary)] mb-2">
          Analyzing Frames
        </h2>

        {/* Frame count */}
        <div className="text-3xl font-mono font-bold text-[color:var(--accent-secondary)] mb-1">
          {frameCount.toLocaleString()}
        </div>
        <p className="text-sm text-[color:var(--text-muted)] mb-4">
          frames being processed
        </p>

        {/* Tool info */}
        <div className={`${captionMuted} px-4 py-2 ${bgSecondary} rounded`}>
          Running <span className="font-medium text-[color:var(--text-secondary)]">{toolName}</span> analysis...
        </div>
      </div>
    </Dialog>
  );
}

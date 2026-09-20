// ui/src/apps/discovery/dialogs/AnalysisProgressDialog.tsx

import { Loader2 } from "lucide-react";
import Dialog, { DialogBody } from "../../../components/Dialog";
import { bgSurface, captionMuted } from "../../../styles";

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
    <Dialog isOpen={isOpen} size="sm">
      <DialogBody className="text-center">
        {/* Animated loader */}
        <div className="mb-4">
          <Loader2 className="w-12 h-12 mx-auto text-purple animate-spin" />
        </div>

        {/* Title */}
        <h2 className="text-lg font-semibold text-primary mb-2">
          Analyzing Frames
        </h2>

        {/* Frame count */}
        <div className="text-3xl font-mono font-bold text-purple mb-1">
          {frameCount.toLocaleString()}
        </div>
        <p className="text-sm text-muted mb-4">
          frames being processed
        </p>

        {/* Tool info */}
        <div className={`${captionMuted} px-4 py-2 ${bgSurface} rounded`}>
          Running <span className="font-medium text-secondary">{toolName}</span> analysis...
        </div>
      </DialogBody>
    </Dialog>
  );
}

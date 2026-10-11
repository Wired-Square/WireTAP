import type { IOStateType } from "../api/io";

export interface SessionStatus {
  label: string;
  dotColour: string | null;
  textColour: string;
}

const STATUS_BY_STATE: Record<IOStateType, SessionStatus> = {
  running: { label: "Running", dotColour: "bg-success-text", textColour: "text-success" },
  paused: { label: "Paused", dotColour: "bg-warning-text", textColour: "text-warning" },
  stopped: { label: "Stopped", dotColour: "bg-text-muted", textColour: "text-muted" },
  starting: { label: "Starting", dotColour: "bg-info-text animate-pulse", textColour: "text-info" },
  error: { label: "Error", dotColour: "bg-danger-text", textColour: "text-danger" },
};

export function sessionStatus(ioState: string): SessionStatus {
  return STATUS_BY_STATE[ioState as IOStateType] ?? { label: ioState, dotColour: null, textColour: "text-secondary" };
}

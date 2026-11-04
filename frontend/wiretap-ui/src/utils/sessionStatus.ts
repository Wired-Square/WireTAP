import i18n from "i18next";
import type { IOStateType } from "../api/io";

export interface SessionStatus {
  label: string;
  dotColour: string | null;
  textColour: string;
}

const COLOURS_BY_STATE: Record<IOStateType, Omit<SessionStatus, "label">> = {
  running: { dotColour: "bg-success-text", textColour: "text-success" },
  paused: { dotColour: "bg-warning-text", textColour: "text-warning" },
  stopped: { dotColour: "bg-text-muted", textColour: "text-muted" },
  starting: { dotColour: "bg-info-text animate-pulse", textColour: "text-info" },
  error: { dotColour: "bg-danger-text", textColour: "text-danger" },
};

export function sessionStatus(ioState: string): SessionStatus {
  const colours = COLOURS_BY_STATE[ioState as IOStateType];
  if (!colours) return { label: ioState, dotColour: null, textColour: "text-secondary" };
  return { label: i18n.t(`common:status.${ioState}`), ...colours };
}

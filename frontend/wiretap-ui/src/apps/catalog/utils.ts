// ui/src/apps/catalog/utils.ts

import { NAME_KEYED_FRAME_ID } from "../../generated/wireConstants";
import type { Frame } from "../../types/catalogModel";
import { formatFrameId as formatHexId } from "../../utils/frameIds";

export type FormattedId = { primary: string; secondary?: string };

/** A catalogue frame's id in both radixes, its hex width by the extended flag; a frame keyed by a name shows its key. */
export function formatFrameId(
  frame: Pick<Frame, "key" | "frameId" | "protocol" | "isExtended">,
  display: "hex" | "decimal",
): FormattedId {
  const keyIsId = frame.protocol === "modbus" ? String(frame.frameId) === frame.key.trim() : frame.frameId !== NAME_KEYED_FRAME_ID;
  if (!keyIsId) return { primary: frame.key };
  const hex = formatHexId(frame.frameId, "hex", frame.isExtended).slice(2);
  const dec = String(frame.frameId);
  return display === "hex" ? { primary: hex, secondary: dec } : { primary: dec, secondary: hex };
}

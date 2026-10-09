import type { CanEditorState } from "../../stores/transmitStore";
import type { DecodedFrame, UnmatchedFrame } from "../../stores/decoderStore";
import type { Frame } from "../../types/catalogModel";
import { formatFrameIdInput } from "../../utils/frameIds";

/** The Transmit editor loaded with a decoded frame, as received. */
export function canEditorFromDecoded(frame: Pick<Frame, "frameId" | "length" | "isExtended" | "bus">, decoded: DecodedFrame | undefined): Partial<CanEditorState> {
  return {
    frameId: formatFrameIdInput(decoded?.frameId ?? frame.frameId),
    dlc: decoded?.dlc ?? frame.length,
    data: [...(decoded?.rawBytes ?? [])],
    isExtended: decoded?.isExtended ?? frame.isExtended ?? false,
    isFd: decoded?.isFd ?? false,
    isBrs: decoded?.isBrs ?? false,
    bus: decoded?.bus ?? frame.bus ?? 0,
  };
}

/** The Transmit editor loaded with an unmatched frame, as received. */
export function canEditorFromUnmatched(frame: UnmatchedFrame): Partial<CanEditorState> {
  return {
    frameId: formatFrameIdInput(frame.frameId),
    dlc: frame.dlc ?? frame.bytes.length,
    data: [...frame.bytes],
    isExtended: frame.isExtended ?? false,
    isFd: frame.isFd ?? false,
    isBrs: frame.isBrs ?? false,
    isRtr: frame.isRtr ?? false,
    bus: frame.bus ?? 0,
  };
}

import type { CanEditorState } from "../../stores/transmitStore";
import type { DecodedFrame, UnmatchedFrame } from "../../stores/decoderStore";
import type { FrameDetail } from "../../types/decoder";

/** The Transmit editor loaded with a decoded frame, at its catalogue length. */
export function canEditorFromDecoded(frame: FrameDetail, decoded: DecodedFrame | undefined): Partial<CanEditorState> {
  return {
    frameId: frame.id.toString(16).toUpperCase(),
    dlc: frame.len,
    data: [...(decoded?.rawBytes ?? [])],
    isExtended: frame.isExtended ?? false,
    isFd: decoded?.isFd ?? false,
    isBrs: decoded?.isBrs ?? false,
    bus: frame.bus ?? 0,
  };
}

/** The Transmit editor loaded with an unmatched frame, as received. */
export function canEditorFromUnmatched(frame: UnmatchedFrame): Partial<CanEditorState> {
  return {
    frameId: frame.frameId.toString(16).toUpperCase(),
    dlc: frame.dlc ?? frame.bytes.length,
    data: [...frame.bytes],
    isExtended: frame.frameId > 0x7ff,
    isFd: frame.isFd ?? false,
    isBrs: frame.isBrs ?? false,
    isRtr: frame.isRtr ?? false,
    bus: 0,
  };
}

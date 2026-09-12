/**
 * Composite frame key utilities.
 *
 * Frame identity is (protocol, frame_id) — e.g. CAN ID 0x100 and Modbus
 * register 256 are distinct even though both have numeric ID 256.
 *
 * Keys are encoded as "protocol:numericId" strings for use as Map keys
 * and Set members.
 */

/** Build a composite key from protocol name and numeric frame ID. */
export function frameKey(protocol: string, frameId: number): string {
  return `${protocol}:${frameId}`;
}

/** Extract protocol and numeric frame ID from a composite key. */
export function parseFrameKey(key: string): { protocol: string; frameId: number } {
  const idx = key.indexOf(":");
  return { protocol: key.slice(0, idx), frameId: Number(key.slice(idx + 1)) };
}

/** Build a composite key from a FrameMessage-shaped object. */
export function keyOf(frame: { protocol: string; frame_id: number }): string {
  return `${frame.protocol}:${frame.frame_id}`;
}

/** A protocol and the frame ids selected under it — the capture filter's wire shape. */
export interface ProtocolFrames {
  protocol: string;
  frame_ids: number[];
  /** Every id of this protocol, seen or not — what a protocol tab asks for. */
  all_ids?: boolean;
}

/** The selection a protocol tab sends: its whole protocol. */
export function wholeProtocol(protocol: string): ProtocolFrames[] {
  return [{ protocol, frame_ids: [], all_ids: true }];
}

/**
 * Group composite keys for the capture filter API.
 *
 * The backend filters on the identity pair, so sending bare numeric ids matched them
 * across protocols — CAN 0x100 and Modbus register 256 selected each other. Grouping
 * keeps the protocol string off every entry: a busy selection is thousands of ids
 * across at most three protocols.
 *
 * An empty result means "no filter", which every consumer reads as "all frames".
 */
export function groupKeysByProtocol(keys: Iterable<string>): ProtocolFrames[] {
  const byProtocol = new Map<string, number[]>();
  for (const key of keys) {
    const { protocol, frameId } = parseFrameKey(key);
    const ids = byProtocol.get(protocol);
    if (ids) ids.push(frameId);
    else byProtocol.set(protocol, [frameId]);
  }
  return [...byProtocol].map(([protocol, frame_ids]) => ({ protocol, frame_ids }));
}

/**
 * Stable React key for a row in a frame table.
 *
 * Distinct from `keyOf` above: that is *frame identity* (which signal this is), this is
 * *row identity* (which row on screen). Frames carry no identity of their own —
 * (timestamp, id, bus) collides whenever a source emits the same ID more than once in the
 * same microsecond, and a duplicate key makes React's reconciler orphan rows it can no
 * longer remove, so they accumulate on every render.
 *
 * Prefer the backend's per-row position (a SQLite rowid); fall back to the row's position
 * in the paged list. The two are namespaced because both are small integers.
 */
export function frameRowKey(captureIndex: number | undefined, position: number): string {
  return captureIndex != null ? `cap:${captureIndex}` : `pos:${position}`;
}

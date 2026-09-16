// Which Discovery toolbox tools a session offers, and whether they have data to work on.
//
// Kept apart from ToolboxDialog so the decision is testable without a DOM: it is a pure
// function of the session's shape, and it was previously wrong in a way no type caught.

/** The data a tool works on — what it needs to be offered, enabled and counted against. */
export type ToolNeeds = 'modbus' | 'serial-bytes' | 'serial-frames' | 'frames';

/** The requirement fields of a tool config; the rest (id, icon, label) is presentation. */
export interface ToolRequirements {
  serialRequires?: 'bytes' | 'frames';
  modbusRequires?: boolean;
}

export interface SessionShape {
  /** The source emits a raw byte stream. */
  isSerialMode: boolean;
  /** The session's protocol is serial, however it delivers its data. */
  isSerialProtocol: boolean;
  /**
   * A source is selected — anything, not just Modbus.
   *
   * The Modbus tools are the one group that *withholds* on this rather than
   * requiring it. A sweep names its own device, opens its own connection and
   * then takes the view over to show what it found, so it has no use for the
   * current source and every reason not to disturb it: joining the sweep's
   * session is what empties and destroys whichever session was selected.
   *
   * The sweeps' own sessions do not count. Chaining probe → unit scan → register
   * sweep is the normal way to work through an unknown device, and the results
   * of the last one are what tell you how to aim the next.
   */
  hasSource: boolean;
}

export interface ToolDataCounts {
  frameCount: number;
  serialFrameCount: number;
  serialBytesCount: number;
}

export function toolNeeds(tool: ToolRequirements): ToolNeeds {
  if (tool.modbusRequires) return 'modbus';
  if (tool.serialRequires === 'bytes') return 'serial-bytes';
  if (tool.serialRequires === 'frames') return 'serial-frames';
  return 'frames';
}

/**
 * Whether this session could ever offer the tool. Whether the data is *there* is
 * `isToolAvailable` — a tool can be listed and still be disabled for want of frames.
 *
 * Serial Payload keys off the protocol, not off serial mode. Serial mode means "this
 * source emits a raw byte stream", which a source that frames in the backend (SLIP, say)
 * never does — so gating on it hid the framed-serial tool from exactly the sessions it
 * was written for.
 */
export function isToolApplicable(tool: ToolRequirements, session: SessionShape): boolean {
  switch (toolNeeds(tool)) {
    // Always listed: a sweep needs no session and no catalogue, so there is no
    // session shape that rules it out — only one that withholds it.
    case 'modbus': return true;
    case 'serial-bytes': return session.isSerialMode;
    case 'serial-frames': return session.isSerialProtocol || session.isSerialMode;
    // Frame tools are meaningless while a serial source is still an unframed stream.
    case 'frames': return !session.isSerialMode;
  }
}

export function hasToolData(
  tool: ToolRequirements,
  session: SessionShape,
  counts: ToolDataCounts
): boolean {
  switch (toolNeeds(tool)) {
    // No frame threshold: a sweep produces the data, it doesn't consume it —
    // what it needs is the device to itself.
    case 'modbus': return !session.hasSource;
    case 'serial-bytes': return counts.serialBytesCount > 0;
    case 'serial-frames': return counts.serialFrameCount > 0;
    case 'frames': return counts.frameCount > 0;
  }
}

// Copyright 2026 Wired Square Pty Ltd

/** Frame def ID sentinel for device-owned signals (hardware config) */
export const FRAME_DEF_ID_DEVICE = 0xFFFF;

/** Frame def ID sentinel for user-created signals */
export const FRAME_DEF_ID_USER = 0xFFFE;

/** Default signal mask — all bits pass through */
export const DEFAULT_SIGNAL_MASK = 0xFFFFFFFF;

/** Start of reserved signal ID range (indicator signals 0xFD00+, device signals 0xFF00+, sentinels).
 *  User signals must use IDs below this value. */
export const RESERVED_SIGNAL_ID_START = 0xFD00;

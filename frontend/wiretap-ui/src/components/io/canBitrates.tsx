// src/components/io/canBitrates.tsx
//
// The CAN bitrate option lists, in one place. These mirror the Rust tables that
// validate them — SLCAN_BITRATES / SLCAN_DATA_BITRATES in io/slcan/reader.rs and
// COMMON_BITRATES in io/gs_usb/mod.rs — so a value offered here is one the
// backend will accept.

/** Nominal (arbitration) phase rates, shared by slcan, socketcan and gs_usb. */
export const CAN_BITRATES = [
  { value: "10000", label: "10 Kbit/s" },
  { value: "20000", label: "20 Kbit/s" },
  { value: "50000", label: "50 Kbit/s" },
  { value: "100000", label: "100 Kbit/s" },
  { value: "125000", label: "125 Kbit/s" },
  { value: "250000", label: "250 Kbit/s" },
  { value: "500000", label: "500 Kbit/s" },
  { value: "750000", label: "750 Kbit/s" },
  { value: "1000000", label: "1 Mbit/s" },
] as const;

/**
 * The same rates, labelled with the serial command that selects them. slcan's
 * S0–S8 are the nominal rates in ascending order, so the suffix is the index —
 * derived rather than restated, so the two lists cannot drift apart.
 */
export const SLCAN_BITRATES = CAN_BITRATES.map((rate, i) => ({
  value: rate.value,
  label: `${rate.label} (S${i})`,
}));

/** slcan CAN FD data phase (ELMUE firmware extension), labelled Y0–Y8. */
export const SLCAN_DATA_BITRATES = [
  { value: "500000", label: "500 Kbit/s (Y0)" },
  { value: "1000000", label: "1 Mbit/s (Y1)" },
  { value: "2000000", label: "2 Mbit/s (Y2)" },
  { value: "4000000", label: "4 Mbit/s (Y4)" },
  { value: "5000000", label: "5 Mbit/s (Y5)" },
  { value: "8000000", label: "8 Mbit/s (Y8)" },
] as const;

/** CAN FD data phase rates for socketcan and gs_usb. */
export const CAN_FD_DATA_BITRATES = [
  { value: "1000000", label: "1 Mbit/s" },
  { value: "2000000", label: "2 Mbit/s" },
  { value: "4000000", label: "4 Mbit/s" },
  { value: "5000000", label: "5 Mbit/s" },
  { value: "8000000", label: "8 Mbit/s" },
] as const;

/** Render an option list as `<option>` elements. */
export function bitrateOptions(
  rates: readonly { value: string; label: string }[],
) {
  return rates.map((r) => (
    <option key={r.value} value={r.value}>
      {r.label}
    </option>
  ));
}

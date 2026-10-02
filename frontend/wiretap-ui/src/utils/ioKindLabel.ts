// src/utils/ioKindLabel.ts

import i18n from "i18next";

/** A profile kind's name, from the same table the device forms read. */
export function getIOKindLabel(kind: string | undefined): string {
  if (!kind) return "";
  return i18n.t(`settings:ioProfileDialog.kinds.${kind}`, { defaultValue: kind });
}

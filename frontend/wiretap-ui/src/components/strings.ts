// The few words a primitive says itself — a dialog's ✕, a toast's dismiss —
// resolved through here so the primitives carry no translation dependency.
// The app sets them once beside its i18n bootstrap; the defaults are English.

export interface PrimitiveStrings {
  close: () => string;
  dismiss: () => string;
}

let strings: PrimitiveStrings = { close: () => "Close", dismiss: () => "Dismiss" };

export function setPrimitiveStrings(next: Partial<PrimitiveStrings>): void {
  strings = { ...strings, ...next };
}

export function primitiveString(key: keyof PrimitiveStrings): string {
  return strings[key]();
}

// src/hooks/useDialogManager.ts
//
// Hook to manage multiple dialog visibility states with a clean API.
// Reduces boilerplate from multiple useState pairs to a single hook call.

import { useState, useCallback, useMemo } from "react";

/** State and controls for a single dialog */
export interface DialogControls {
  /** Whether the dialog is currently open */
  isOpen: boolean;
  /** Open the dialog */
  open: () => void;
  /** Close the dialog */
  close: () => void;
  /** Toggle the dialog */
  toggle: () => void;
}

/** Result type mapping dialog names to their controls */
export type DialogManagerResult<T extends readonly string[]> = {
  [K in T[number]]: DialogControls;
};

/**
 * Hook to manage multiple dialog visibility states.
 *
 * @example
 * ```tsx
 * const dialogs = useDialogManager([
 *   'ioReaderPicker',
 *   'framePicker',
 *   'speedPicker',
 * ] as const);
 *
 * // Usage
 * dialogs.ioReaderPicker.isOpen    // boolean
 * dialogs.ioReaderPicker.open()    // opens the dialog
 * dialogs.ioReaderPicker.close()   // closes the dialog
 *
 * // In JSX
 * <IoReaderPickerDialog
 *   isOpen={dialogs.ioReaderPicker.isOpen}
 *   onClose={dialogs.ioReaderPicker.close}
 * />
 * ```
 */
export function useDialogManager<T extends readonly string[]>(
  dialogNames: T
): DialogManagerResult<T> {
  // Store all dialog states in a single object
  const [openDialogs, setOpenDialogs] = useState<Set<string>>(() => new Set());

  // Create stable callbacks for open/close/toggle
  const open = useCallback((name: string) => {
    setOpenDialogs((prev) => {
      const next = new Set(prev);
      next.add(name);
      return next;
    });
  }, []);

  const close = useCallback((name: string) => {
    setOpenDialogs((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  }, []);

  const toggle = useCallback((name: string) => {
    setOpenDialogs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  // Build the result object with memoized controls for each dialog
  const result = useMemo(() => {
    const controls = {} as DialogManagerResult<T>;

    for (const name of dialogNames) {
      (controls as Record<string, DialogControls>)[name] = {
        get isOpen() {
          return openDialogs.has(name);
        },
        open: () => open(name),
        close: () => close(name),
        toggle: () => toggle(name),
      };
    }

    return controls;
  }, [dialogNames, openDialogs, open, close, toggle]);

  return result;
}

/**
 * Helper to create a dialog manager with initial open states.
 *
 * @example
 * ```tsx
 * const dialogs = useDialogManagerWithDefaults({
 *   ioReaderPicker: false,
 *   framePicker: false,
 *   speedPicker: true, // starts open
 * });
 * ```
 */
export function useDialogManagerWithDefaults<T extends Record<string, boolean>>(
  defaults: T
): { [K in keyof T]: DialogControls } {
  const names = Object.keys(defaults) as (keyof T & string)[];
  const initialOpen = new Set(
    names.filter((name) => defaults[name])
  );

  const [openDialogs, setOpenDialogs] = useState<Set<string>>(() => initialOpen);

  const open = useCallback((name: string) => {
    setOpenDialogs((prev) => {
      const next = new Set(prev);
      next.add(name);
      return next;
    });
  }, []);

  const close = useCallback((name: string) => {
    setOpenDialogs((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  }, []);

  const toggle = useCallback((name: string) => {
    setOpenDialogs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const result = useMemo(() => {
    const controls = {} as { [K in keyof T]: DialogControls };

    for (const name of names) {
      (controls as Record<string, DialogControls>)[name] = {
        get isOpen() {
          return openDialogs.has(name);
        },
        open: () => open(name),
        close: () => close(name),
        toggle: () => toggle(name),
      };
    }

    return controls;
  }, [names, openDialogs, open, close, toggle]);

  return result;
}

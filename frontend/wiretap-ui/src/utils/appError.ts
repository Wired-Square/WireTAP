import { useSessionStore } from "../stores/sessionStore";

/**
 * Wraps an async operation with standardised error handling.
 * On failure: logs to console, shows the app error dialog, returns false.
 * On success: returns true.
 */
export async function withAppError(
  title: string,
  message: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`[${title}] ${message}:`, e);
    useSessionStore.getState().showAppError(title, message, detail);
    return false;
  }
}

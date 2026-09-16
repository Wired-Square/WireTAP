// Event bus utility for inter-window communication

import { emit, emitTo, listen } from '@tauri-apps/api/event';
import type { WindowLabel } from '../utils/windows';

export class EventBus {
  /**
   * Broadcast event to all windows
   */
  static async broadcast<T>(event: string, payload: T): Promise<void> {
    await emit(event, payload);
  }

  /**
   * Send event to specific window
   */
  static async send<T>(target: WindowLabel, event: string, payload: T): Promise<void> {
    await emitTo(target, event, payload);
  }

  /**
   * Subscribe to events
   * Returns unlisten function
   */
  static async subscribe<T>(
    event: string,
    handler: (payload: T) => void | Promise<void>
  ): Promise<() => void> {
    const unlisten = await listen<T>(event, async (e) => {
      await handler(e.payload);
    });
    return unlisten;
  }
}

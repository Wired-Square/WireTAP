// ui/src/apps/graph/widgets/customWorkerHost.ts
//
// Main-thread controller for one custom-widget worker. Owns the requestAnimation-
// Frame loop (so animation works regardless of WebKit worker-rAF support), ticks
// the worker with the latest signal values + time/dt, and enforces a watchdog:
// a worker that misses its response deadline (e.g. an infinite loop) is the only
// thing it can do wrong, and termination is the only safe way to stop it.

import type { CustomMode } from "./customWorkerProtocol";
import type { WorkerToHost } from "./customWorkerProtocol";

export interface CustomHostCallbacks {
  onBitmap?: (bmp: ImageBitmap) => void;
  onSvg?: (markup: string) => void;
  onError?: (message: string, phase: "compile" | "draw") => void;
  onTimeout?: () => void;
}

const WATCHDOG_MS = 1000;
const MAX_CONSECUTIVE_ERRORS = 30;

export class CustomWidgetHost {
  private worker: Worker;
  private ready = false;
  private awaiting = false;
  private disabled = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private rafId: number | null = null;
  private startTime = 0;
  private lastTickTime = 0;
  private lastSentTime = 0;
  private errorCount = 0;

  constructor(
    private mode: CustomMode,
    private code: string,
    private getSignals: () => Float64Array,
    private getDims: () => { width: number; height: number },
    private fps: number,
    private cb: CustomHostCallbacks,
  ) {
    this.worker = this.spawn();
    this.rafId = requestAnimationFrame(this.loop);
  }

  private spawn(): Worker {
    const worker = new Worker(new URL("./customWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = this.onMessage;
    worker.onerror = (e) => {
      this.cb.onError?.(e.message || "worker crashed", "draw");
      this.disabled = true;
    };
    worker.postMessage({ kind: "init", mode: this.mode, code: this.code });
    return worker;
  }

  private onMessage = (e: MessageEvent<WorkerToHost>) => {
    const msg = e.data;
    switch (msg.kind) {
      case "ready":
        this.ready = true;
        break;
      case "bitmap":
        this.settle();
        this.cb.onBitmap?.(msg.bitmap);
        break;
      case "svg":
        this.settle();
        this.cb.onSvg?.(msg.markup);
        break;
      case "error":
        if (msg.phase === "compile") {
          this.disabled = true;
        } else {
          this.awaiting = false;
          this.clearWatchdog();
          this.errorCount++;
          if (this.errorCount >= MAX_CONSECUTIVE_ERRORS) this.disabled = true;
        }
        this.cb.onError?.(msg.message, msg.phase);
        break;
    }
  };

  /** A frame completed successfully: clear the watchdog and reset error backoff. */
  private settle() {
    this.awaiting = false;
    this.errorCount = 0;
    this.clearWatchdog();
  }

  private clearWatchdog() {
    if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
  }

  private loop = (now: number) => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.disabled || !this.ready || this.awaiting) return;
    if (this.startTime === 0) { this.startTime = now; this.lastTickTime = now; }
    if (now - this.lastSentTime < 1000 / this.fps) return;

    const { width, height } = this.getDims();
    if (width <= 0 || height <= 0) return;

    const signals = this.getSignals();
    const time = (now - this.startTime) / 1000;
    const dt = (now - this.lastTickTime) / 1000;
    this.lastTickTime = now;
    this.lastSentTime = now;

    this.awaiting = true;
    this.worker.postMessage({ kind: "frame", signals, time, dt, width, height }, [signals.buffer]);
    this.watchdog = setTimeout(() => this.onWatchdog(), WATCHDOG_MS);
  };

  private onWatchdog() {
    // The worker is stuck (e.g. infinite loop). Terminate is the only safe stop.
    this.worker.terminate();
    this.disabled = true;
    this.awaiting = false;
    this.watchdog = null;
    this.cb.onTimeout?.();
  }

  destroy() {
    this.disabled = true;
    this.clearWatchdog();
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.worker.terminate();
  }
}

// ui/src/apps/graph/widgets/customWorker.ts
//
// Sandboxed worker that runs author-supplied draw code. It has NO DOM, NO Tauri
// IPC (those live only on the main window's global), and we additionally scrub
// network/storage globals below. It receives signal numbers and returns either
// an ImageBitmap (canvas mode) or an SVG markup string (svg mode). The main
// thread treats svg markup as untrusted and sanitises it before injection.

/// <reference lib="webworker" />

import type { HostToWorker, WorkerToHost, CustomMode } from "./customWorkerProtocol";

// Remove ambient network/storage so author code cannot phone home even though it
// already has no Tauri/DOM access.
const g = self as unknown as Record<string, unknown>;
for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "indexedDB", "caches", "EventSource"]) {
  try { g[name] = undefined; } catch { /* some are non-configurable; best-effort */ }
}

type CanvasDrawFn = (ctx: OffscreenCanvasRenderingContext2D, frame: FrameArg) => void;
type SvgDrawFn = (signals: number[], frame: Omit<FrameArg, "signals">) => unknown;
interface FrameArg { signals: number[]; width: number; height: number; time: number; dt: number }

let mode: CustomMode = "canvas";
let canvasFn: CanvasDrawFn | null = null;
let svgFn: SvgDrawFn | null = null;
let off: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function post(msg: WorkerToHost, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

function compile(code: string) {
  // Compiled once. Runs inside this already-sandboxed worker scope.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("\"use strict\"; return (" + code + ");");
  return factory();
}

self.onmessage = (e: MessageEvent<HostToWorker>) => {
  const msg = e.data;

  if (msg.kind === "init") {
    mode = msg.mode;
    try {
      const fn = compile(msg.code);
      if (typeof fn !== "function") throw new Error("code must evaluate to a function");
      if (mode === "canvas") canvasFn = fn as CanvasDrawFn;
      else svgFn = fn as SvgDrawFn;
      post({ kind: "ready" });
    } catch (err) {
      post({ kind: "error", message: String((err as Error)?.message ?? err), phase: "compile" });
    }
    return;
  }

  if (msg.kind === "frame") {
    const { signals, time, dt, width, height } = msg;
    const sig = Array.from(signals);
    try {
      if (mode === "canvas") {
        if (!canvasFn) return;
        if (!off || off.width !== width || off.height !== height) {
          off = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
          ctx = off.getContext("2d");
        }
        if (!ctx || !off) return;
        ctx.clearRect(0, 0, off.width, off.height);
        canvasFn(ctx, { signals: sig, width, height, time, dt });
        const bitmap = off.transferToImageBitmap();
        post({ kind: "bitmap", bitmap }, [bitmap]);
      } else {
        if (!svgFn) return;
        const markup = String(svgFn(sig, { width, height, time, dt }) ?? "");
        post({ kind: "svg", markup });
      }
    } catch (err) {
      post({ kind: "error", message: String((err as Error)?.message ?? err), phase: "draw" });
    }
  }
};

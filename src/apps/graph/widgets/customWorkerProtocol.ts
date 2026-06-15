// ui/src/apps/graph/widgets/customWorkerProtocol.ts
//
// Message protocol between the main thread and the sandboxed custom-widget
// worker. The worker has no DOM, no Tauri bridge, and no network — it receives
// only signal numbers and returns pixels (canvas) or markup (svg).

export type CustomMode = "canvas" | "svg";

export type HostToWorker =
  | { kind: "init"; mode: CustomMode; code: string }
  | { kind: "frame"; signals: Float64Array; time: number; dt: number; width: number; height: number };

export type WorkerToHost =
  | { kind: "ready" }
  | { kind: "bitmap"; bitmap: ImageBitmap }
  | { kind: "svg"; markup: string }
  | { kind: "error"; message: string; phase: "compile" | "draw" };

// ui/src/apps/graph/views/panels/raw-canvas/RawCanvasPanel.tsx
//
// Animated, scriptable canvas. The author's draw fn runs in a sandboxed Worker
// (see customWorker.ts) which returns an ImageBitmap each frame; we blit it onto
// the visible <canvas> so PNG export keeps working.

import { useEffect, useRef, useState } from "react";
import { type GraphPanel } from "../../../../../stores/graphStore";
import { useCanvasExportRef } from "../../../widgets/useExportRef";
import { customWidgetKeys, makeSignalSampler } from "../../../widgets/useSignalValues";
import WidgetEmpty from "../../../widgets/WidgetEmpty";
import WidgetError from "../../../widgets/WidgetError";
import { CustomWidgetHost } from "../../../widgets/customWorkerHost";

interface Props {
  panel: GraphPanel;
  canvasRef?: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>;
}

export default function RawCanvasPanel({ panel, canvasRef }: Props) {
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  useCanvasExportRef(canvasElRef, canvasRef);
  const [error, setError] = useState<string | null>(null);

  const cfg = panel.widgetConfig?.rawCanvas;
  const code = cfg?.code;
  const fps = cfg?.fps ?? 30;
  const keys = customWidgetKeys(panel.signals, cfg?.signalKeys).join(",");

  useEffect(() => {
    const visible = canvasElRef.current;
    if (!code || !visible) return;
    const vctx = visible.getContext("2d");
    setError(null);

    const getSignals = makeSignalSampler(keys ? keys.split(",") : []);
    const getDims = () => ({ width: visible.clientWidth, height: visible.clientHeight });

    const host = new CustomWidgetHost("canvas", code, getSignals, getDims, fps, {
      onBitmap: (bmp) => {
        const w = visible.clientWidth, h = visible.clientHeight;
        if (visible.width !== w) visible.width = w;
        if (visible.height !== h) visible.height = h;
        vctx?.clearRect(0, 0, w, h);
        vctx?.drawImage(bmp, 0, 0, w, h);
        bmp.close();
      },
      onError: (m) => setError(m),
      onTimeout: () => setError("Draw timed out — code was stopped"),
    });
    return () => host.destroy();
  }, [code, fps, keys]);

  if (!code) {
    return <WidgetEmpty>Add custom canvas code in Configure</WidgetEmpty>;
  }

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasElRef} className="block h-full w-full" />
      {error && <WidgetError>{error}</WidgetError>}
    </div>
  );
}

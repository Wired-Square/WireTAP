// ui/src/apps/graph/widgets/useExportRef.ts
//
// Registers a widget's <svg>/<canvas> element with GraphGrid's export getter so
// PNG/SVG export works uniformly. Factors the effect every widget repeats.

import { useEffect, type RefObject } from "react";

export function useSvgExportRef(
  elRef: RefObject<SVGSVGElement | null>,
  prop?: React.MutableRefObject<(() => SVGSVGElement | null) | null>,
) {
  useEffect(() => {
    if (prop) prop.current = () => elRef.current;
    return () => { if (prop) prop.current = null; };
  }, [prop, elRef]);
}

export function useCanvasExportRef(
  elRef: RefObject<HTMLCanvasElement | null>,
  prop?: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>,
) {
  useEffect(() => {
    if (prop) prop.current = () => elRef.current;
    return () => { if (prop) prop.current = null; };
  }, [prop, elRef]);
}

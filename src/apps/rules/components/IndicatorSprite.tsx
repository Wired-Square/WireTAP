// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// SVG indicator sprite inspired by WireTAP logo — rounded square outer,
// filled inner section. Defined as SVG symbol for reuse via <use>.

import { textTertiary } from "../../../styles";

interface IndicatorSpriteProps {
  colour: string;
  state: "off" | "on" | "blink";
  size?: number;
  label?: string;
}

export function IndicatorSpriteDefs() {
  return (
    <svg className="absolute w-0 h-0" aria-hidden="true">
      <defs>
        <symbol id="indicator-sprite" viewBox="0 0 40 40">
          <rect
            x="2"
            y="2"
            width="36"
            height="36"
            rx="8"
            ry="8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <rect
            x="8"
            y="8"
            width="24"
            height="24"
            rx="4"
            ry="4"
            fill="currentColor"
            className="indicator-fill"
          />
        </symbol>
      </defs>
    </svg>
  );
}

export default function IndicatorSprite({
  colour,
  state,
  size = 40,
  label,
}: IndicatorSpriteProps) {
  const fillColour = state === "off" ? "rgba(128,128,128,0.3)" : colour;
  const animClass = state === "blink" ? "animate-pulse" : "";

  return (
    <div className="flex flex-col items-center gap-1">
      <svg
        width={size}
        height={size}
        className={animClass}
        style={{ color: fillColour }}
      >
        <use href="#indicator-sprite" />
      </svg>
      {label && (
        <span className={`text-xs ${textTertiary} text-center truncate max-w-[60px]`}>
          {label}
        </span>
      )}
    </div>
  );
}

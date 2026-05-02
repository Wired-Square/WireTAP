// ui/src/apps/serial/views/SerialTerminalView.tsx
//
// Mounts an xterm.js terminal that displays bytes coming from the direct
// serial-terminal backend and forwards keystrokes back via the supplied
// `write` callback. Built to handle ANSI-coloured µC output (Zephyr shell,
// MicroPython REPL, vendor bootloaders) without us implementing an ANSI
// parser ourselves.

import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { tlog } from "../../../api/settings";

export interface SerialTerminalHandle {
  /** Write incoming bytes (from backend) to the terminal display. */
  writeBytes: (bytes: Uint8Array) => void;
  /** Clear the terminal display. */
  clear: () => void;
}

interface Props {
  /** When provided, keystrokes are forwarded via this callback. */
  write: ((bytes: number[]) => Promise<void>) | null;
  /** When true, append \n after \r when the user presses Enter. */
  crlfMode?: boolean;
  /** When true, echo typed characters locally before sending. */
  localEcho?: boolean;
}

const SerialTerminalView = forwardRef<SerialTerminalHandle, Props>(
  function SerialTerminalView({ write, crlfMode = false, localEcho = false }, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const termRef = useRef<XTerm | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const writeRef = useRef(write);
    const crlfRef = useRef(crlfMode);
    const echoRef = useRef(localEcho);

    useEffect(() => {
      writeRef.current = write;
    }, [write]);
    useEffect(() => {
      crlfRef.current = crlfMode;
    }, [crlfMode]);
    useEffect(() => {
      echoRef.current = localEcho;
    }, [localEcho]);

    // Mount xterm once
    useEffect(() => {
      if (!containerRef.current) return;
      const term = new XTerm({
        convertEol: false,
        cursorBlink: true,
        fontFamily: '"Ubuntu Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        scrollback: 5000,
        theme: {
          background: "#0b0f14",
          foreground: "#dde3ec",
          cursor: "#7dd3fc",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      try {
        fit.fit();
      } catch {
        /* element not laid out yet */
      }

      const disposer = term.onData((data) => {
        if (echoRef.current) term.write(data);
        const out = crlfRef.current ? data.replace(/\r/g, "\r\n") : data;
        const fn = writeRef.current;
        if (!fn) return;
        const bytes = textToBytes(out);
        fn(bytes).catch((e) => {
          tlog.info(`[Serial] write failed: ${e}`);
        });
      });

      termRef.current = term;
      fitRef.current = fit;

      const resizeObserver = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* ignore transient layout errors */
        }
      });
      resizeObserver.observe(containerRef.current);

      return () => {
        resizeObserver.disconnect();
        disposer.dispose();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        writeBytes: (bytes) => {
          const term = termRef.current;
          if (!term || bytes.length === 0) return;
          term.write(bytes);
        },
        clear: () => termRef.current?.clear(),
      }),
      [],
    );

    return (
      <div
        ref={containerRef}
        className="flex-1 min-h-0 bg-[#0b0f14] p-2"
      />
    );
  },
);

function textToBytes(s: string): number[] {
  const enc = new TextEncoder();
  return Array.from(enc.encode(s));
}

export default SerialTerminalView;

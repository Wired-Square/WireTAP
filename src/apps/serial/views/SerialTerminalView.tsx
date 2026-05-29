// ui/src/apps/serial/views/SerialTerminalView.tsx
//
// Mounts an xterm.js terminal that displays bytes coming from the direct
// serial-terminal backend and forwards keystrokes back via the supplied
// `write` callback. Built to handle ANSI-coloured µC output (Zephyr shell,
// MicroPython REPL, vendor bootloaders) without us implementing an ANSI
// parser ourselves.
//
// Clipboard: xterm renders to a canvas, so the native browser copy/paste
// can't see the selection. We wire it ourselves — a right-click context
// menu plus keyboard shortcuts (Cmd+C/V/A on macOS, Ctrl+Shift+C/V/A on
// Windows/Linux so a bare Ctrl+C still reaches the device as an interrupt).

import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useCallback,
  forwardRef,
} from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Copy, ClipboardPaste, TextSelect, CopyPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@xterm/xterm/css/xterm.css";

import ContextMenu, { type ContextMenuItem } from "../../../components/ContextMenu";
import { iconXs } from "../../../styles/spacing";
import { tlog } from "../../../api/settings";
import { readClipboardText, writeClipboardText } from "../../../api/clipboard";

export interface SerialTerminalHandle {
  /** Write incoming bytes (from backend) to the terminal display. */
  writeBytes: (bytes: Uint8Array) => void;
  /** Clear the terminal display. */
  clear: () => void;
  /** Return the entire buffer (scrollback + viewport) as plain text. */
  getText: () => string;
}

interface Props {
  /** When provided, keystrokes are forwarded via this callback. */
  write: ((bytes: number[]) => Promise<void>) | null;
  /** When true, append \n after \r when the user presses Enter. */
  crlfMode?: boolean;
  /** When true, echo typed characters locally before sending. */
  localEcho?: boolean;
  /** Display font size in px. Changes apply live. */
  fontSize?: number;
}

// ── Clipboard helpers (module-level so the once-mounted key handler and the
//    context menu share the same logic without stale-closure worries) ──

/** Flatten the full xterm buffer (scrollback + viewport) to plain text. */
function getAllText(term: XTerm): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n").trimEnd();
}

function copySelection(term: XTerm) {
  const sel = term.getSelection();
  if (!sel) return;
  writeClipboardText(sel).catch((e) => tlog.info(`[Serial] copy failed: ${e}`));
}

function copyAll(term: XTerm) {
  writeClipboardText(getAllText(term)).catch((e) =>
    tlog.info(`[Serial] copy all failed: ${e}`),
  );
}

function pasteClipboard(term: XTerm) {
  readClipboardText()
    .then((text) => {
      // term.paste() routes through onData, so local echo / CRLF still apply.
      if (text) term.paste(text);
    })
    .catch((e) => tlog.info(`[Serial] paste failed: ${e}`));
}

const SerialTerminalView = forwardRef<SerialTerminalHandle, Props>(
  function SerialTerminalView(
    { write, crlfMode = false, localEcho = false, fontSize = 13 },
    ref,
  ) {
    const { t } = useTranslation("serial");
    const containerRef = useRef<HTMLDivElement | null>(null);
    const termRef = useRef<XTerm | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const writeRef = useRef(write);
    const crlfRef = useRef(crlfMode);
    const echoRef = useRef(localEcho);

    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

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
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize,
        lineHeight: 1.25,
        letterSpacing: 0.5,
        scrollback: 5000,
        theme: {
          background: "#0b0f14",
          foreground: "#dde3ec",
          cursor: "#7dd3fc",
          // Visible highlight on the near-black background — without this the
          // selection is barely perceptible. Inactive matches active so the
          // highlight stays readable after focus leaves the terminal.
          selectionBackground: "#2f5d86",
          selectionInactiveBackground: "#2f5d86",
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

      // Clipboard shortcuts. Returning false consumes the event (we handled
      // it); returning true lets xterm forward it to the device — so a bare
      // Ctrl+C still interrupts the remote shell.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        const meta = e.metaKey && !e.ctrlKey && !e.altKey;
        const ctrlShift = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
        if (!meta && !ctrlShift) return true;
        // We handle these ourselves. preventDefault() stops the browser's own
        // copy/paste from also firing (xterm listens for the native paste event,
        // so without this Cmd+V pastes twice — once here, once natively).
        switch (e.key.toLowerCase()) {
          case "c":
            copySelection(term);
            e.preventDefault();
            return false;
          case "v":
            pasteClipboard(term);
            e.preventDefault();
            return false;
          case "a":
            term.selectAll();
            e.preventDefault();
            return false;
          default:
            return true;
        }
      });

      // Copy-on-select: highlighting text copies it straight to the clipboard
      // (no-op while the selection is empty, e.g. a plain click).
      const selDisposer = term.onSelectionChange(() => copySelection(term));

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
        selDisposer.dispose();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }, []);

    // Apply font-size changes live, then re-fit so the column/row count tracks.
    useEffect(() => {
      const term = termRef.current;
      if (!term) return;
      term.options.fontSize = fontSize;
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore transient layout errors */
      }
    }, [fontSize]);

    useImperativeHandle(
      ref,
      () => ({
        writeBytes: (bytes) => {
          const term = termRef.current;
          if (!term || bytes.length === 0) return;
          term.write(bytes);
        },
        clear: () => termRef.current?.clear(),
        getText: () => {
          const term = termRef.current;
          return term ? getAllText(term) : "";
        },
      }),
      [],
    );

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY });
    }, []);

    const buildMenuItems = (): ContextMenuItem[] => {
      const term = termRef.current;
      const items: ContextMenuItem[] = [];
      if (term?.hasSelection()) {
        items.push({
          label: t("contextMenu.copy"),
          icon: <Copy className={iconXs} />,
          onClick: () => term && copySelection(term),
        });
      }
      items.push(
        {
          label: t("contextMenu.paste"),
          icon: <ClipboardPaste className={iconXs} />,
          onClick: () => term && pasteClipboard(term),
        },
        { separator: true, label: "", onClick: () => {} },
        {
          label: t("contextMenu.selectAll"),
          icon: <TextSelect className={iconXs} />,
          onClick: () => term?.selectAll(),
        },
        {
          label: t("contextMenu.copyAll"),
          icon: <CopyPlus className={iconXs} />,
          onClick: () => term && copyAll(term),
        },
      );
      return items;
    };

    return (
      <>
        <div
          ref={containerRef}
          onContextMenu={handleContextMenu}
          className="flex-1 min-h-0 bg-[#0b0f14] p-2"
        />
        {menu && (
          <ContextMenu
            items={buildMenuItems()}
            position={menu}
            onClose={() => setMenu(null)}
          />
        )}
      </>
    );
  },
);

function textToBytes(s: string): number[] {
  const enc = new TextEncoder();
  return Array.from(enc.encode(s));
}

export default SerialTerminalView;

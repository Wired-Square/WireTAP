// ui/src/apps/calculator/FrameCalculator.tsx

import { useMemo, useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { RotateCcw, Copy, ClipboardPaste, Calculator, History, Trash2, ArrowRight, Hash, Type, Binary, CopyPlus, Divide } from "lucide-react";
import { useCalculatorStore } from "../../stores/calculatorStore";
import AppLayout from "../../components/AppLayout";
import ByteBits from "../../components/ByteBits";
import Dialog from "../../components/Dialog";
import FlexSeparator from "../../components/FlexSeparator";
import { SecondaryButton } from "../../components/forms";
import { useSettings } from "../../hooks/useSettings";
import { cleanHex, hexToBytes, numberToHex, decodeGroups } from "./frameUtils";
import { buttonBase, iconButtonBase, toggleButtonClass, selectionButtonClass, groupButtonClass, disabledState, caption, captionMuted, borderDivider, hoverLight, bgSurface } from "../../styles";
import { borderDataView, bgDataView } from "../../styles/colourTokens";
import { iconMd, iconSm, iconXs, iconLg, flexRowGap2 } from "../../styles/spacing";
import { h2, sectionHeaderText } from "../../styles/typography";

export type Endianness = "little" | "big" | "mid-little" | "mid-big";
export type GroupMode = "1B" | "2B" | "4B" | "8B" | "custom-bits" | "custom-bytes";
export type CustomUnit = "bits" | "bytes";
export type InputMode = "hex" | "number" | "string";

export type GroupedValue = {
  index: number;
  bits: number;
  hex: string;
  unsigned: bigint;
  signedTwos: bigint;
  signedOnes: bigint;
  signedMag: bigint;
  text: string;
  binary: string;
  // For ByteBits component visualization
  displayHex: string; // Full bytes to display (for sub-byte, shows the containing byte)
  bitOffset: number; // Starting bit position within the displayed bytes (deprecated, use usedBitRange)
  startByteIndex: number; // Starting byte index in the original data for labeling
  usedBitStart: number; // Lowest bit index that is used (inclusive)
  usedBitEnd: number; // Highest bit index that is used (inclusive)
};

function stringToHex(str: string): string {
  return Array.from(str)
    .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
}

// Wrapper component that scales ByteBits to fit container width
type ScalingByteBitsProps = React.ComponentProps<typeof ByteBits>;

function ScalingByteBits(props: ScalingByteBitsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  // Store the natural (unscaled) width of the content
  const naturalWidthRef = useRef<number>(0);

  useLayoutEffect(() => {
    const measureAndScale = () => {
      if (!containerRef.current || !contentRef.current) return;

      // Temporarily remove transform to measure natural width
      contentRef.current.style.transform = 'none';
      const naturalWidth = contentRef.current.scrollWidth;
      naturalWidthRef.current = naturalWidth;

      const containerWidth = containerRef.current.offsetWidth;

      if (naturalWidth > containerWidth && naturalWidth > 0) {
        // Scale down to fit, with a minimum scale of 0.4
        const newScale = Math.max(0.4, containerWidth / naturalWidth);
        contentRef.current.style.transform = `scale(${newScale})`;
        setScale(newScale);
      } else {
        // Content fits, use full scale
        contentRef.current.style.transform = 'scale(1)';
        setScale(1);
      }
    };

    // Measure after a frame to ensure layout is complete
    requestAnimationFrame(measureAndScale);

    // Also update on resize
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(measureAndScale);
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [props.hexValue, props.totalBits]);

  return (
    <div ref={containerRef} className="w-full overflow-hidden">
      <div
        ref={contentRef}
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        <ByteBits {...props} />
      </div>
    </div>
  );
}

export default function FrameCalculator() {
  const { settings } = useSettings();
  const [endianness, setEndianness] = useState<Endianness>("little");
  const [rotateInterval, setRotateInterval] = useState<number>(1);
  const [groupMode, setGroupMode] = useState<GroupMode>("2B");
  const [customSizeInput, setCustomSizeInput] = useState<string>("1");
  const [inputMode, setInputMode] = useState<InputMode>("hex");
  const [rawInput, setRawInput] = useState<string>("");
  const [isRotating, setIsRotating] = useState<boolean>(false);

  // Memory/history state
  const [history, setHistory] = useState<string[]>([]);

  // Custom grouping dialog state
  const [showCustomDialog, setShowCustomDialog] = useState(false);
  const [dialogUnit, setDialogUnit] = useState<CustomUnit>("bytes");
  const [dialogInput, setDialogInput] = useState("");
  const [customLabel, setCustomLabel] = useState<string | null>(null);

  // History picker dialog state
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);

  // Endianness dialog state
  const [showEndiannessDialog, setShowEndiannessDialog] = useState(false);

  // Rotate interval dialog state
  const [showRotateDialog, setShowRotateDialog] = useState(false);

  // Scale calculator dialog state
  const [showScaleDialog, setShowScaleDialog] = useState(false);
  const [targetValueInput, setTargetValueInput] = useState("");

  // Get binary colour from settings, default to teal
  const binaryColour = settings?.binary_one_colour || "#14b8a6";

  // Convert rawInput to hexInput based on inputMode
  const hexInput = useMemo(() => {
    if (inputMode === "hex") {
      return rawInput;
    } else if (inputMode === "number") {
      try {
        const num = rawInput.trim();
        if (!num) return "";
        // Support both decimal and hex (0x prefix) input
        const value = num.startsWith("0x") || num.startsWith("0X")
          ? BigInt(num)
          : BigInt(num);
        const beHex = numberToHex(value);
        // Apply byte ordering based on endianness
        // numberToHex produces big-endian, so reverse bytes for little-endian
        if (endianness === "little") {
          const beBytes = hexToBytes(beHex);
          return beBytes.reverse().map(b => b.toString(16).padStart(2, '0')).join('');
        } else if (endianness === "mid-little" || endianness === "mid-big") {
          // Mid-endian: swap bytes within each 16-bit word
          const beBytes = hexToBytes(beHex);
          // Pad to even number of bytes for word swapping
          if (beBytes.length % 2 !== 0) beBytes.unshift(0);
          const result: number[] = [];
          for (let i = 0; i < beBytes.length; i += 2) {
            if (endianness === "mid-little") {
              // Swap bytes within words, then reverse word order
              result.unshift(beBytes[i + 1], beBytes[i]);
            } else {
              // Just swap bytes within each word
              result.push(beBytes[i + 1], beBytes[i]);
            }
          }
          return result.map(b => b.toString(16).padStart(2, '0')).join('');
        }
        return beHex;
      } catch {
        return "";
      }
    } else if (inputMode === "string") {
      return stringToHex(rawInput);
    }
    return "";
  }, [rawInput, inputMode, endianness]);

  const bytes = useMemo(() => hexToBytes(cleanHex(hexInput)), [hexInput]);

  const groups = useMemo(() => {
    return decodeGroups(bytes, groupMode, customSizeInput, endianness);
  }, [bytes, groupMode, customSizeInput, endianness]);

  // Handler for bit toggles - updates the original hex input
  const handleBitToggle = useCallback((groupIndex: number, newHexValue: string) => {
    const group = groups[groupIndex];
    if (!group) return;

    // Get the current bytes array
    const currentBytes = [...bytes];

    // Parse the new hex value
    const newBytes = hexToBytes(cleanHex(newHexValue));

    // Update the original bytes at the correct position
    // startByteIndex tells us where this group's bytes are in the original data
    const startIdx = group.startByteIndex;
    for (let i = 0; i < newBytes.length && startIdx + i < currentBytes.length; i++) {
      currentBytes[startIdx + i] = newBytes[i];
    }

    // Convert back to hex and update the input
    const newHexInput = currentBytes.map(b => b.toString(16).padStart(2, '0')).join('');
    setRawInput(newHexInput);
  }, [groups, bytes]);

  // Check for pending hex data from other panels
  const pendingHexData = useCalculatorStore((s) => s.pendingHexData);
  const clearPendingHexData = useCalculatorStore((s) => s.clearPendingHexData);

  useEffect(() => {
    if (pendingHexData) {
      // Add current value to history before replacing (if not empty and not duplicate)
      const currentValue = rawInput.trim();
      if (currentValue && !history.includes(currentValue)) {
        setHistory((prev) => [...prev, currentValue]);
      }
      setInputMode("hex");
      setRawInput(pendingHexData);
      clearPendingHexData();
    }
  }, [pendingHexData, clearPendingHexData, rawInput, history]);

  // M+ button handler - adds current value to history if not already present
  const handleMemoryAdd = useCallback(() => {
    const value = rawInput.trim();
    if (!value) return;
    // Don't add if already in history
    if (history.includes(value)) return;
    setHistory((prev) => [...prev, value]);
  }, [rawInput, history]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleanHex(hexInput));
    } catch (err) {
      console.warn("Copy failed", err);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setRawInput((prev: string) => (prev || "").concat(text));
    } catch (err) {
      console.warn("Paste failed", err);
    }
  };

  const handleCopyValue = useCallback(async (value: string | number | bigint) => {
    try {
      await navigator.clipboard.writeText(String(value));
    } catch (err) {
      console.warn("Copy failed", err);
    }
  }, []);

  // Rotation logic
  const rotateEndianness = useCallback(() => {
    const endiannessOrder: Endianness[] = ["little", "big", "mid-little", "mid-big"];
    const currentIndex = endiannessOrder.indexOf(endianness);
    const nextIndex = (currentIndex + 1) % endiannessOrder.length;
    setEndianness(endiannessOrder[nextIndex]);
  }, [endianness]);

  const toggleRotate = useCallback(() => {
    setIsRotating((prev) => !prev);
  }, []);

  // Grouping dialog handlers
  const openGroupingDialog = useCallback(() => {
    // Pre-populate with current custom values if in custom mode
    if (groupMode === "custom-bits" || groupMode === "custom-bytes") {
      setDialogUnit(groupMode === "custom-bits" ? "bits" : "bytes");
      setDialogInput(customSizeInput);
    } else {
      setDialogUnit("bytes");
      setDialogInput("");
    }
    setShowCustomDialog(true);
  }, [groupMode, customSizeInput]);

  const handlePresetSelect = useCallback((mode: GroupMode) => {
    setGroupMode(mode);
    setCustomLabel(null);
    setShowCustomDialog(false);
  }, []);

  const handleCustomOk = useCallback(() => {
    const trimmed = dialogInput.trim();
    if (trimmed) {
      const newMode: GroupMode = dialogUnit === "bits" ? "custom-bits" : "custom-bytes";
      setGroupMode(newMode);
      setCustomSizeInput(trimmed);
      // Create a display label
      const unitLabel = dialogUnit === "bits" ? "b" : "B";
      setCustomLabel(`${trimmed}${unitLabel}`);
    }
    setShowCustomDialog(false);
  }, [dialogInput, dialogUnit]);

  const handleCustomCancel = useCallback(() => {
    setShowCustomDialog(false);
  }, []);

  // History picker dialog handlers
  const openHistoryDialog = useCallback(() => {
    if (history.length > 0) {
      setShowHistoryDialog(true);
    }
  }, [history.length]);

  const handleHistoryCopyToClipboard = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch (err) {
      console.warn("Copy failed", err);
    }
  }, []);

  const handleHistorySetActive = useCallback((value: string) => {
    setRawInput(value);
    setShowHistoryDialog(false);
  }, []);

  const handleHistoryDelete = useCallback((index: number) => {
    setHistory((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleHistoryDialogClose = useCallback(() => {
    setShowHistoryDialog(false);
  }, []);

  const handleHistoryCopyAll = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(history.join('\n'));
    } catch (err) {
      console.warn("Copy failed", err);
    }
  }, [history]);

  // Auto-rotate effect
  useEffect(() => {
    if (!isRotating || rotateInterval <= 0) return;

    const intervalMs = rotateInterval * 1000;
    const timer = setInterval(() => {
      rotateEndianness();
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isRotating, rotateInterval, rotateEndianness]);

  const topBar = (
    <div className={`${bgSurface} ${borderDivider} px-4 py-2 space-y-2`}>
      {/* First row: All buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <Calculator className={`${iconLg} text-[color:var(--accent-primary)] shrink-0`} />

        <FlexSeparator />

        {/* Rotate button */}
        <button
          className={toggleButtonClass(isRotating, "yellow")}
          title={isRotating ? "Stop auto-rotation" : "Start auto-rotation"}
          onClick={toggleRotate}
        >
          <RotateCcw className={`${iconMd} ${isRotating ? "animate-spin" : ""}`} />
        </button>

        {/* Rotate interval button - opens dialog */}
        <button
          onClick={() => setShowRotateDialog(true)}
          className={buttonBase}
          title="Set rotation interval"
        >
          {rotateInterval}s
        </button>

        {/* Endianness button - opens dialog */}
        <button
          onClick={() => setShowEndiannessDialog(true)}
          className={buttonBase}
          title="Set byte order"
        >
          {endianness === "little" ? "Little" : endianness === "big" ? "Big" : endianness === "mid-little" ? "Mid-Little" : "Mid-Big"}
        </button>

        {/* Separator */}
        <FlexSeparator />

        {/* Grouping button - opens dialog with all options */}
        <button
          onClick={openGroupingDialog}
          className={buttonBase}
          title="Set grouping mode"
        >
          {(groupMode === "custom-bits" || groupMode === "custom-bytes") && customLabel
            ? customLabel
            : groupMode}
        </button>

        {/* Separator */}
        <FlexSeparator />

        {/* Input mode selector - icon buttons */}
        <button
          onClick={() => setInputMode("hex")}
          className={groupButtonClass(inputMode === "hex")}
          title="Hex input"
        >
          <Binary className={iconMd} />
        </button>
        <button
          onClick={() => setInputMode("number")}
          className={groupButtonClass(inputMode === "number")}
          title="Number input"
        >
          <Hash className={iconMd} />
        </button>
        <button
          onClick={() => setInputMode("string")}
          className={groupButtonClass(inputMode === "string")}
          title="String input"
        >
          <Type className={iconMd} />
        </button>

        {/* Separator */}
        <FlexSeparator />

        {/* Memory buttons */}
        <button
          onClick={handleMemoryAdd}
          disabled={!rawInput.trim() || history.includes(rawInput.trim())}
          className={buttonBase}
          title="Add to memory"
        >
          M+
        </button>
        <button
          onClick={openHistoryDialog}
          className={`${buttonBase} ${history.length > 0 ? "text-[color:var(--accent-primary)]" : ""}`}
          title={history.length > 0 ? `Memory (${history.length})` : "Memory empty"}
        >
          M{history.length > 0 && <span className="ml-1 text-xs opacity-70">{history.length}</span>}
        </button>

        {/* Separator */}
        <FlexSeparator />

        {/* Clipboard buttons */}
        <button
          onClick={handleCopy}
          className={iconButtonBase}
          title="Copy hex"
        >
          <Copy className={iconMd} />
        </button>
        <button
          onClick={handlePaste}
          className={iconButtonBase}
          title="Paste"
        >
          <ClipboardPaste className={iconMd} />
        </button>

        {/* Separator */}
        <FlexSeparator />

        {/* Scale calculator button */}
        <button
          onClick={() => {
            setTargetValueInput("");
            setShowScaleDialog(true);
          }}
          className={iconButtonBase}
          title="Calculate scale factor"
          disabled={groups.length === 0}
        >
          <Divide className={iconMd} />
        </button>
      </div>

      {/* Second row: Input only */}
      <div className={flexRowGap2}>
        <input
          type="text"
          value={rawInput}
          onChange={(e) => setRawInput(e.target.value)}
          className="flex-1 min-w-32 px-3 py-1.5 rounded border bg-[var(--data-bg)] border-[color:var(--border-default)] font-ubuntu-mono text-base text-[color:var(--data-text-primary)] tracking-wider uppercase"
          placeholder={
            inputMode === "hex"
              ? "01020304"
              : inputMode === "number"
              ? "16909060"
              : "Hello"
          }
        />
        {inputMode !== "hex" && hexInput && (
          <span className={`${caption} font-mono shrink-0`}>
            → {hexInput}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <>
      <AppLayout topBar={topBar}>
        {/* Bubble container */}
        <div className={`flex-1 flex flex-col min-h-0 rounded-lg border ${borderDataView} overflow-hidden ${bgDataView}`}>
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <div className="grid grid-cols-1 gap-4">
            {groups.map((g, groupIdx) => {
              // Format hex with uppercase pairs and no 0x prefix
              const hexFormatted = g.hex
                .replace('0x', '')
                .toUpperCase()
                .match(/.{1,2}/g)
                ?.join(' ') || '';

              return (
                <div
                  key={g.index}
                  className={`p-4 rounded-xl border border-[color:var(--border-default)] ${bgSurface} shadow-sm flex flex-col gap-3`}
                >
                  {/* Top section: Values */}
                  <div className="min-w-0">
                    {/* Header */}
                    <div className="mb-3">
                      <div className="text-sm font-semibold text-[color:var(--text-primary)]">
                        Group {g.index}
                      </div>
                      <div className={captionMuted}>
                        {g.bits} bits
                      </div>
                    </div>

                    {/* Values with copy buttons */}
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between items-center group">
                        <span>Hex</span>
                        <div className={flexRowGap2}>
                          <span className="font-mono">{hexFormatted}</span>
                          <button
                            onClick={() => handleCopyValue(g.hex.replace('0x', ''))}
                            className={`opacity-0 group-hover:opacity-100 p-1 rounded ${hoverLight} transition-opacity`}
                            title="Copy hex value"
                          >
                            <Copy className={`${iconXs} text-[color:var(--text-secondary)]`} />
                          </button>
                        </div>
                      </div>
                      <div className="flex justify-between items-center group">
                        <span>Unsigned</span>
                        <div className={flexRowGap2}>
                          <span className="font-mono">{g.unsigned.toString()}</span>
                          <button
                            onClick={() => handleCopyValue(g.unsigned)}
                            className={`opacity-0 group-hover:opacity-100 p-1 rounded ${hoverLight} transition-opacity`}
                            title="Copy unsigned value"
                          >
                            <Copy className={`${iconXs} text-[color:var(--text-secondary)]`} />
                          </button>
                        </div>
                      </div>
                      <div className="flex justify-between items-center group">
                        <span>Signed (2's)</span>
                        <div className={flexRowGap2}>
                          <span className="font-mono">{g.signedTwos.toString()}</span>
                          <button
                            onClick={() => handleCopyValue(g.signedTwos)}
                            className={`opacity-0 group-hover:opacity-100 p-1 rounded ${hoverLight} transition-opacity`}
                            title="Copy signed (2's complement) value"
                          >
                            <Copy className={`${iconXs} text-[color:var(--text-secondary)]`} />
                          </button>
                        </div>
                      </div>
                      <div className="flex justify-between items-center group">
                        <span>Signed (1's)</span>
                        <div className={flexRowGap2}>
                          <span className="font-mono">{g.signedOnes.toString()}</span>
                          <button
                            onClick={() => handleCopyValue(g.signedOnes)}
                            className={`opacity-0 group-hover:opacity-100 p-1 rounded ${hoverLight} transition-opacity`}
                            title="Copy signed (1's complement) value"
                          >
                            <Copy className={`${iconXs} text-[color:var(--text-secondary)]`} />
                          </button>
                        </div>
                      </div>
                      <div className="flex justify-between items-center group">
                        <span>Sign-Magnitude</span>
                        <div className={flexRowGap2}>
                          <span className="font-mono">{g.signedMag.toString()}</span>
                          <button
                            onClick={() => handleCopyValue(g.signedMag)}
                            className={`opacity-0 group-hover:opacity-100 p-1 rounded ${hoverLight} transition-opacity`}
                            title="Copy sign-magnitude value"
                          >
                            <Copy className={`${iconXs} text-[color:var(--text-secondary)]`} />
                          </button>
                        </div>
                      </div>
                      <div className="flex justify-between items-center group">
                        <span>Text</span>
                        <div className={flexRowGap2}>
                          <span className="font-mono break-all">{g.text}</span>
                          <button
                            onClick={() => handleCopyValue(g.text)}
                            className={`opacity-0 group-hover:opacity-100 p-1 rounded ${hoverLight} transition-opacity`}
                            title="Copy text value"
                          >
                            <Copy className={`${iconXs} text-[color:var(--text-secondary)]`} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Bottom section: Bit preview - always below values */}
                  <div className="flex-shrink-0 pt-2 border-t border-[color:var(--border-default)] overflow-hidden">
                    <div className="flex justify-between items-center group mb-2">
                      <span className="text-sm">Binary</span>
                      <button
                        onClick={() => handleCopyValue(g.binary)}
                        className={`opacity-0 group-hover:opacity-100 p-1 rounded ${hoverLight} transition-opacity`}
                        title="Copy binary"
                      >
                        <Copy className={`${iconXs} text-[color:var(--text-secondary)]`} />
                      </button>
                    </div>
                    <ScalingByteBits
                      hexValue={g.displayHex}
                      byteOrder="big"
                      bitColor={binaryColour}
                      totalBits={g.bits}
                      bitOffset={g.bitOffset}
                      startByteIndex={g.startByteIndex}
                      usedBitStart={g.usedBitStart}
                      usedBitEnd={g.usedBitEnd}
                      interactive={true}
                      onBitToggle={(newHex) => handleBitToggle(groupIdx, newHex)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          </div>
        </div>
      </AppLayout>

      {/* Grouping Dialog */}
      <Dialog isOpen={showCustomDialog} maxWidth="max-w-sm" onBackdropClick={handleCustomCancel}>
        <div className="p-6">
          <h2 className={`${h2} mb-4`}>Grouping Mode</h2>

          <div className="space-y-4">
            {/* Preset options */}
            <div>
              <label className={`block ${sectionHeaderText} mb-2`}>
                Preset
              </label>
              <div className="grid grid-cols-4 gap-2">
                {(["1B", "2B", "4B", "8B"] as GroupMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => handlePresetSelect(mode)}
                    className={selectionButtonClass(groupMode === mode)}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-[var(--hover-bg)]" />
              <span className={captionMuted}>or custom</span>
              <div className="flex-1 h-px bg-[var(--hover-bg)]" />
            </div>

            {/* Custom unit selector */}
            <div>
              <label className={`block ${sectionHeaderText} mb-2`}>
                Unit
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => setDialogUnit("bits")}
                  className={`flex-1 ${selectionButtonClass(dialogUnit === "bits")}`}
                >
                  Bits
                </button>
                <button
                  onClick={() => setDialogUnit("bytes")}
                  className={`flex-1 ${selectionButtonClass(dialogUnit === "bytes")}`}
                >
                  Bytes
                </button>
              </div>
            </div>

            {/* Custom sizes input */}
            <div>
              <label className={`block ${sectionHeaderText} mb-2`}>
                Group Sizes
              </label>
              <input
                type="text"
                value={dialogInput}
                onChange={(e) => setDialogInput(e.target.value)}
                className="w-full px-3 py-2 rounded border bg-[var(--bg-surface)] border-[color:var(--border-default)] font-mono text-sm"
                placeholder={dialogUnit === "bits" ? "8,8,16,2,2" : "1,1,2,2"}
              />
              <p className={`${caption} mt-1`}>
                Comma-separated list of {dialogUnit === "bits" ? "bit" : "byte"} sizes
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <SecondaryButton onClick={handleCustomCancel}>Close</SecondaryButton>
            <button
              onClick={handleCustomOk}
              disabled={!dialogInput.trim()}
              className={`px-4 py-2 rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors ${disabledState}`}
            >
              Apply Custom
            </button>
          </div>
        </div>
      </Dialog>

      {/* History Picker Dialog */}
      <Dialog isOpen={showHistoryDialog} maxWidth="max-w-md" onBackdropClick={handleHistoryDialogClose}>
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-[var(--status-info-bg)] rounded-lg">
              <History className={`${iconLg} text-[color:var(--accent-primary)]`} />
            </div>
            <h2 className={h2}>Memory</h2>
          </div>

          <div className="space-y-2 max-h-80 overflow-y-auto">
            {history.map((item, index) => {
              const isCurrentItem = item === rawInput.trim();
              return (
                <div
                  key={index}
                  className={`flex items-center gap-2 p-3 rounded-lg border transition-colors ${
                    isCurrentItem
                      ? "border-[color:var(--accent-primary)] bg-[var(--status-info-bg)]"
                      : "border-[color:var(--border-default)] hover:bg-[var(--hover-bg)]"
                  }`}
                >
                  <span className="text-xs text-[color:var(--text-muted)] w-6">
                    {index + 1}
                  </span>
                  <span className="flex-1 font-led text-sm text-[color:var(--accent-primary)] uppercase tracking-wider truncate">
                    {item}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleHistoryCopyToClipboard(item)}
                      className={iconButtonBase}
                      title="Copy to clipboard"
                    >
                      <Copy className={iconSm} />
                    </button>
                    <button
                      onClick={() => handleHistorySetActive(item)}
                      className={`${iconButtonBase} text-[color:var(--accent-primary)]`}
                      title="Set as active value"
                    >
                      <ArrowRight className={iconSm} />
                    </button>
                    <button
                      onClick={() => handleHistoryDelete(index)}
                      className={`${iconButtonBase} text-[color:var(--status-danger-text)]`}
                      title="Delete from memory"
                    >
                      <Trash2 className={iconSm} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex justify-between mt-4">
            <button
              onClick={handleHistoryCopyAll}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--status-info-bg)] text-[color:var(--accent-primary)] hover:brightness-95 transition-colors"
              title="Copy all history items"
            >
              <CopyPlus className={iconMd} />
              Copy All
            </button>
            <SecondaryButton onClick={handleHistoryDialogClose}>Close</SecondaryButton>
          </div>
        </div>
      </Dialog>

      {/* Endianness Dialog */}
      <Dialog isOpen={showEndiannessDialog} maxWidth="max-w-sm" onBackdropClick={() => setShowEndiannessDialog(false)}>
        <div className="p-6">
          <h2 className={`${h2} mb-4`}>Byte Order</h2>
          <div className="grid grid-cols-2 gap-2">
            {([
              { value: "little", label: "Little" },
              { value: "big", label: "Big" },
              { value: "mid-little", label: "Mid-Little" },
              { value: "mid-big", label: "Mid-Big" },
            ] as const).map((option) => (
              <button
                key={option.value}
                onClick={() => {
                  setEndianness(option.value);
                  setShowEndiannessDialog(false);
                }}
                className={selectionButtonClass(endianness === option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex justify-end mt-4">
            <SecondaryButton onClick={() => setShowEndiannessDialog(false)}>Close</SecondaryButton>
          </div>
        </div>
      </Dialog>

      {/* Rotate Interval Dialog */}
      <Dialog isOpen={showRotateDialog} maxWidth="max-w-sm" onBackdropClick={() => setShowRotateDialog(false)}>
        <div className="p-6">
          <h2 className={`${h2} mb-4`}>Rotation Interval</h2>
          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3, 5, 10, 15].map((interval) => (
              <button
                key={interval}
                onClick={() => {
                  setRotateInterval(interval);
                  setShowRotateDialog(false);
                }}
                className={selectionButtonClass(rotateInterval === interval)}
              >
                {interval}s
              </button>
            ))}
          </div>
          <div className="flex justify-end mt-4">
            <SecondaryButton onClick={() => setShowRotateDialog(false)}>Close</SecondaryButton>
          </div>
        </div>
      </Dialog>

      {/* Scale Calculator Dialog */}
      <Dialog isOpen={showScaleDialog} maxWidth="max-w-sm" onBackdropClick={() => setShowScaleDialog(false)}>
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-[var(--status-info-bg)] rounded-lg">
              <Divide className={`${iconLg} text-[color:var(--accent-primary)]`} />
            </div>
            <h2 className={h2}>Scale Calculator</h2>
          </div>

          <div className="space-y-4">
            {/* Raw value display */}
            <div>
              <label className={`block ${sectionHeaderText} mb-1`}>
                Raw Value (from hex)
              </label>
              <div className="px-3 py-2 rounded border bg-[var(--bg-surface)] border-[color:var(--border-default)] font-mono text-sm">
                {groups.length > 0 ? groups[0].unsigned.toString() : "—"}
              </div>
            </div>

            {/* Target value input */}
            <div>
              <label className={`block ${sectionHeaderText} mb-1`}>
                Target Value (desired result)
              </label>
              <input
                type="text"
                value={targetValueInput}
                onChange={(e) => setTargetValueInput(e.target.value)}
                className="w-full px-3 py-2 rounded border bg-[var(--bg-surface)] border-[color:var(--border-default)] font-mono text-sm"
                placeholder="e.g. 92647"
                autoFocus
              />
            </div>

            {/* Calculated scale */}
            {(() => {
              if (groups.length === 0) return null;
              const rawValue = groups[0].unsigned;
              const targetValue = (() => {
                try {
                  const trimmed = targetValueInput.trim();
                  if (!trimmed) return null;
                  return parseFloat(trimmed);
                } catch {
                  return null;
                }
              })();

              if (targetValue === null || isNaN(targetValue) || Number(rawValue) === 0) return null;

              const scale = targetValue / Number(rawValue);

              return (
                <div className="p-4 rounded-lg bg-[var(--status-info-bg)] border border-[color:var(--status-info-border)]">
                  <div className="text-sm text-[color:var(--text-secondary)] mb-1">
                    Scale Factor (DBC)
                  </div>
                  <div className={flexRowGap2}>
                    <span className="text-2xl font-mono font-semibold text-[color:var(--accent-primary)]">
                      {scale.toPrecision(6)}
                    </span>
                    <button
                      onClick={() => handleCopyValue(scale.toPrecision(6))}
                      className="p-1.5 rounded hover:brightness-95 transition-colors"
                      title="Copy scale factor"
                    >
                      <Copy className={`${iconMd} text-[color:var(--accent-primary)]`} />
                    </button>
                  </div>
                  <div className={`${caption} mt-2 font-mono`}>
                    {targetValue} ÷ {rawValue.toString()} = {scale.toPrecision(6)}
                  </div>
                  <div className={`${caption} mt-1`}>
                    raw × {scale.toPrecision(6)} = physical
                  </div>
                </div>
              );
            })()}
          </div>

          <div className="flex justify-end mt-6">
            <SecondaryButton onClick={() => setShowScaleDialog(false)}>Close</SecondaryButton>
          </div>
        </div>
      </Dialog>
    </>
  );
}

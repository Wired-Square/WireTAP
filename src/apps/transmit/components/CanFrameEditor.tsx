// ui/src/apps/transmit/components/CanFrameEditor.tsx
//
// CAN frame editor component with ID, DLC, flags, bus selector, and data grid.

import { useCallback, useState, useEffect } from "react";
import { useTransmitStore, CAN_FD_DLC_VALUES } from "../../../stores/transmitStore";
import { useActiveSession } from "../../../stores/sessionStore";
import {
  borderDataView,
  textDataPrimary,
  bgDataInput,
  textDataSecondary,
} from "../../../styles/colourTokens";
import { toggleChipClass } from "../../../styles/buttonStyles";

export default function CanFrameEditor() {
  // Local state for tracking focused data byte (allows select-all and type to replace)
  const [focusedByteIndex, setFocusedByteIndex] = useState<number | null>(null);

  // Store selectors
  const activeSession = useActiveSession();
  const canEditor = useTransmitStore((s) => s.canEditor);

  // Store actions
  const updateCanEditor = useTransmitStore((s) => s.updateCanEditor);
  const setCanDataByte = useTransmitStore((s) => s.setCanDataByte);

  // Get capabilities from active session
  const capabilities = activeSession?.capabilities;
  const supportsFd = capabilities?.supports_canfd ?? false;
  const supportsExtended = capabilities?.supports_extended_id ?? true;
  const supportsRtr = capabilities?.supports_rtr ?? false;
  const availableBuses = capabilities?.available_buses ?? [];
  const isMultiBus = availableBuses.length > 1;

  // Reset bus selection when available buses change and current selection is invalid
  useEffect(() => {
    if (availableBuses.length > 0 && !availableBuses.includes(canEditor.bus)) {
      // Select the first available bus
      updateCanEditor({ bus: availableBuses[0] });
    }
  }, [availableBuses, canEditor.bus, updateCanEditor]);

  // Classic CAN DLC values
  const classicDlcValues = [0, 1, 2, 3, 4, 5, 6, 7, 8];

  // Get DLC values based on FD mode
  const dlcValues = canEditor.isFd ? CAN_FD_DLC_VALUES : classicDlcValues;

  // Handle frame ID change
  const handleFrameIdChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // Allow only hex characters
      const value = e.target.value.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
      updateCanEditor({ frameId: value });
    },
    [updateCanEditor]
  );

  // Handle DLC change
  const handleDlcChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const dlc = parseInt(e.target.value, 10);
      updateCanEditor({ dlc });
    },
    [updateCanEditor]
  );

  // Handle bus change
  const handleBusChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const bus = parseInt(e.target.value, 10);
      updateCanEditor({ bus });
    },
    [updateCanEditor]
  );

  // Handle flag toggles
  const handleExtendedToggle = useCallback(() => {
    updateCanEditor({ isExtended: !canEditor.isExtended });
  }, [canEditor.isExtended, updateCanEditor]);

  const handleFdToggle = useCallback(() => {
    const newFd = !canEditor.isFd;
    // Reset DLC to 8 when toggling FD off (if current DLC > 8)
    const dlc = !newFd && canEditor.dlc > 8 ? 8 : canEditor.dlc;
    updateCanEditor({ isFd: newFd, dlc });
  }, [canEditor.isFd, canEditor.dlc, updateCanEditor]);

  const handleBrsToggle = useCallback(() => {
    updateCanEditor({ isBrs: !canEditor.isBrs });
  }, [canEditor.isBrs, updateCanEditor]);

  const handleRtrToggle = useCallback(() => {
    updateCanEditor({ isRtr: !canEditor.isRtr });
  }, [canEditor.isRtr, updateCanEditor]);

  // Handle data byte change
  const handleDataByteChange = useCallback(
    (index: number, value: string) => {
      const byte = parseInt(value, 16);
      if (!isNaN(byte) && byte >= 0 && byte <= 255) {
        setCanDataByte(index, byte);
      } else if (value === "") {
        setCanDataByte(index, 0);
      }
    },
    [setCanDataByte]
  );

  // Render data bytes grid (8 bytes per row)
  const renderDataGrid = () => {
    const rows: React.ReactElement[] = [];
    const bytesPerRow = 8;
    const totalRows = Math.ceil(canEditor.dlc / bytesPerRow);

    for (let row = 0; row < totalRows; row++) {
      const startIndex = row * bytesPerRow;
      const endIndex = Math.min(startIndex + bytesPerRow, canEditor.dlc);
      const cells: React.ReactElement[] = [];

      for (let i = startIndex; i < endIndex; i++) {
        // When focused, show raw value (allows select-all + type to replace)
        // When not focused, pad with zeros for display
        const byteValue = canEditor.data[i] ?? 0;
        const displayValue = focusedByteIndex === i
          ? byteValue.toString(16).toUpperCase()
          : byteValue.toString(16).toUpperCase().padStart(2, "0");

        cells.push(
          <div key={i} className="flex flex-col items-center">
            <span className={`${textDataSecondary} text-[10px] mb-0.5`}>
              {i.toString().padStart(2, "0")}
            </span>
            <input
              type="text"
              value={displayValue}
              onChange={(e) => handleDataByteChange(i, e.target.value)}
              onFocus={() => setFocusedByteIndex(i)}
              onBlur={() => setFocusedByteIndex(null)}
              maxLength={2}
              className={`w-8 h-8 ${bgDataInput} ${textDataPrimary} text-center font-mono text-sm rounded border ${borderDataView} focus:outline-none focus:border-blue-500 uppercase`}
            />
          </div>
        );
      }

      // Pad with empty cells to maintain grid alignment
      while (cells.length < bytesPerRow) {
        cells.push(
          <div key={`empty-${row}-${cells.length}`} className="w-8 h-8" />
        );
      }

      rows.push(
        <div key={row} className="flex gap-1">
          {cells}
        </div>
      );
    }

    return rows;
  };

  return (
    <div className="space-y-4">
      {/* First Row: ID, DLC, Bus */}
      <div className="flex items-end gap-4 flex-wrap">
        {/* Frame ID */}
        <div className="flex flex-col">
          <label className={`${textDataSecondary} text-xs mb-1`}>Frame ID</label>
          <div className="flex items-center">
            <span className={`${textDataSecondary} text-sm mr-1`}>0x</span>
            <input
              type="text"
              value={canEditor.frameId}
              onChange={handleFrameIdChange}
              maxLength={canEditor.isExtended ? 8 : 3}
              placeholder={canEditor.isExtended ? "12345678" : "123"}
              className={`w-24 ${bgDataInput} ${textDataPrimary} font-mono text-sm rounded px-2 py-1.5 border ${borderDataView} focus:outline-none focus:border-blue-500 uppercase`}
            />
          </div>
        </div>

        {/* DLC */}
        <div className="flex flex-col">
          <label className={`${textDataSecondary} text-xs mb-1`}>DLC</label>
          <select
            value={canEditor.dlc}
            onChange={handleDlcChange}
            className={`w-20 ${bgDataInput} ${textDataPrimary} text-sm rounded px-2 py-1.5 border ${borderDataView} focus:outline-none focus:border-blue-500`}
          >
            {dlcValues.map((dlc) => (
              <option key={dlc} value={dlc}>
                {dlc}
              </option>
            ))}
          </select>
        </div>

        {/* Bus (only for multi-bus) */}
        {isMultiBus && (
          <div className="flex flex-col">
            <label className={`${textDataSecondary} text-xs mb-1`}>Bus</label>
            <select
              value={canEditor.bus}
              onChange={handleBusChange}
              className={`w-24 ${bgDataInput} ${textDataPrimary} text-sm rounded px-2 py-1.5 border ${borderDataView} focus:outline-none focus:border-blue-500`}
            >
              {availableBuses.map((bus) => (
                <option key={bus} value={bus}>
                  Bus {bus}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Second Row: Flags */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`${textDataSecondary} text-xs mr-2`}>Flags:</span>

        {supportsExtended && (
          <button
            onClick={handleExtendedToggle}
            className={toggleChipClass(canEditor.isExtended)}
          >
            Extended (29-bit)
          </button>
        )}

        {supportsFd && (
          <button
            onClick={handleFdToggle}
            className={toggleChipClass(canEditor.isFd)}
          >
            CAN FD
          </button>
        )}

        {supportsFd && canEditor.isFd && (
          <button
            onClick={handleBrsToggle}
            className={toggleChipClass(canEditor.isBrs)}
          >
            BRS
          </button>
        )}

        {supportsRtr && !canEditor.isFd && (
          <button
            onClick={handleRtrToggle}
            className={toggleChipClass(canEditor.isRtr)}
          >
            RTR
          </button>
        )}
      </div>

      {/* Third Row: Data Bytes */}
      {canEditor.dlc > 0 && !canEditor.isRtr && (
        <div className="space-y-2">
          <label className={`${textDataSecondary} text-xs`}>Data Bytes:</label>
          <div className="space-y-1">{renderDataGrid()}</div>
        </div>
      )}

      {/* RTR notice */}
      {canEditor.isRtr && (
        <div className={`${textDataSecondary} text-xs italic`}>
          RTR (Remote Transmission Request) frames have no data payload.
        </div>
      )}
    </div>
  );
}

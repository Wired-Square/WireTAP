// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from "react";
import Dialog from "../../../components/Dialog";
import { inputSimple, labelDefault } from "../../../styles/inputStyles";
import { textPrimary, textSecondary } from "../../../styles";
import { panelFooter } from "../../../styles/cardStyles";
import type { FrameHeader } from "../utils/bitGrid";
import { nextAvailableId } from "../utils/framelinkConstants";
import { formatHexId } from "../utils/formatHex";

interface FrameDefDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (headerInfo: {
    frameDefId: number;
    interfaceType: number;
    header: FrameHeader;
    payloadBytes: number;
    name?: string;
    description?: string;
  }) => void;
  interfaces: { index: number; iface_type: number; name: string }[];
  usedIds: Set<number>;
}

export default function FrameDefDialog({
  isOpen,
  onClose,
  onSubmit,
  interfaces,
  usedIds,
}: FrameDefDialogProps) {
  const [frameDefId, setFrameDefId] = useState(() => nextAvailableId(usedIds));
  const [validationError, setValidationError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // Re-compute next available ID and reset fields when dialog opens
  useEffect(() => {
    if (isOpen) {
      setFrameDefId(nextAvailableId(usedIds));
      setName("");
      setDescription("");
    }
  }, [isOpen, usedIds]);
  const [interfaceType, setInterfaceType] = useState(
    interfaces[0]?.iface_type ?? 1,
  );
  const [canId, setCanId] = useState("0");
  const [dlc, setDlc] = useState(8);
  const [extended, setExtended] = useState(false);
  const [payloadLength, setPayloadLength] = useState(64);

  const handleSubmit = () => {
    if (usedIds.has(frameDefId)) {
      setValidationError(`Frame Def ID ${formatHexId(frameDefId)} is already in use.`);
      return;
    }
    setValidationError(null);
    const isCan = interfaceType === 1 || interfaceType === 2;
    if (isCan) {
      const canIdNum = parseInt(canId, 16);
      if (isNaN(canIdNum)) return;
    }
    const header: FrameHeader = isCan
      ? { type: "can", canId: parseInt(canId, 16) || 0, dlc, extended }
      : { type: "serial", framingMode: 0 };
    onSubmit({
      frameDefId,
      interfaceType,
      header,
      payloadBytes: isCan ? dlc : payloadLength,
      name: name || undefined,
      description: description || undefined,
    });
    onClose();
  };

  const isCan = interfaceType === 1 || interfaceType === 2;

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-2xl">
      <div className="p-6">
        <h2 className={`text-lg font-semibold ${textPrimary} mb-4`}>
          Add Frame Definition
        </h2>

        {validationError && (
          <div className="mb-3 p-2 text-xs text-red-400 bg-red-500/10 rounded">{validationError}</div>
        )}

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className={labelDefault}>Name</label>
            <input
              className={inputSimple}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <div>
            <label className={labelDefault}>Description</label>
            <input
              className={inputSimple}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className={labelDefault}>Frame Def ID</label>
            <input
              type="number"
              className={inputSimple}
              value={frameDefId}
              onChange={(e) => setFrameDefId(parseInt(e.target.value) || 0)}
            />
          </div>
          <div>
            <label className={labelDefault}>Interface Type</label>
            <select
              className={inputSimple}
              value={interfaceType}
              onChange={(e) => setInterfaceType(parseInt(e.target.value))}
            >
              {interfaces.map((iface) => (
                <option key={iface.index} value={iface.iface_type}>
                  {iface.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {isCan && (
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label className={labelDefault}>CAN ID (hex)</label>
              <input
                type="text"
                className={`${inputSimple} font-mono`}
                value={canId}
                onChange={(e) => setCanId(e.target.value)}
                placeholder="1A0"
              />
            </div>
            <div>
              <label className={labelDefault}>DLC</label>
              <input
                type="number"
                className={inputSimple}
                value={dlc}
                min={1}
                max={64}
                onChange={(e) => setDlc(parseInt(e.target.value) || 8)}
              />
            </div>
            <div className="flex items-end pb-2">
              <label className={`flex items-center gap-2 text-sm ${textSecondary}`}>
                <input
                  type="checkbox"
                  checked={extended}
                  onChange={(e) => setExtended(e.target.checked)}
                />
                Extended ID
              </label>
            </div>
          </div>
        )}

        {!isCan && (
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className={labelDefault}>Payload Length (bytes)</label>
              <input
                type="number"
                className={inputSimple}
                value={payloadLength}
                min={1}
                max={512}
                onChange={(e) => setPayloadLength(Math.min(512, parseInt(e.target.value) || 64))}
              />
            </div>
          </div>
        )}
      </div>

      <div className={`${panelFooter} flex justify-end gap-2`}>
        <button
          onClick={onClose}
          className={`px-4 py-2 text-sm rounded ${textSecondary} hover:bg-white/10`}
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          className="px-4 py-2 text-sm font-medium rounded bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          Add Frame Definition
        </button>
      </div>
    </Dialog>
  );
}

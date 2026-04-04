// ui/src/dialogs/BulkAddToTransmitDialog.tsx
//
// Dialog for adding Discovery frames to the Transmit queue.
// Uses whatever session the Transmit panel is currently connected to.
// The user selects a frame ID range, output bus (if multi-bus), and repeat interval.

import { useState, useEffect, useMemo } from "react";
import Dialog from "../components/Dialog";
import { DialogFooter } from "../components/forms/DialogFooter";
import { helpText, labelSmall, inputSimple } from "../styles";
import { useTransmitStore } from "../stores/transmitStore";
import {
  getDiscoveryFrameBuffer,
  useDiscoveryFrameStore,
} from "../stores/discoveryFrameStore";
import { parseFrameKey } from "../utils/frameKey";
import { openPanel } from "../utils/windowCommunication";
import { useSessionStore } from "../stores/sessionStore";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function BulkAddToTransmitDialog({ isOpen, onClose }: Props) {
  const addCanFramesBulk = useTransmitStore((s) => s.addCanFramesBulk);
  const getGroupNames = useTransmitStore((s) => s.getGroupNames);
  const defaultIntervalMs = useTransmitStore((s) => s.queueRepeatIntervalMs);
  const frameInfoMap = useDiscoveryFrameStore((s) => s.frameInfoMap);

  // Get the Transmit app's active session (only Transmit.tsx calls setActiveSession)
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const transmitSession = activeSessionId ? sessions[activeSessionId] : null;
  const availableBuses: number[] = transmitSession?.capabilities?.available_buses ?? [];

  const [bus, setBus] = useState<number>(0);
  const [intervalMs, setIntervalMs] = useState<number>(1000);
  const [groupName, setGroupName] = useState("");
  const [minIdRaw, setMinIdRaw] = useState("");
  const [maxIdRaw, setMaxIdRaw] = useState("");

  // Reset state when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    setIntervalMs(defaultIntervalMs);
    setGroupName("");
    setMinIdRaw("");
    setMaxIdRaw("");
    setBus(availableBuses[0] ?? 0);
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Parse hex inputs — empty means use boundary value (0 or 0x1FFFFFFF)
  const minId = useMemo(() => {
    if (!minIdRaw.trim()) return 0;
    const n = parseInt(minIdRaw, 16);
    return isNaN(n) ? null : n;
  }, [minIdRaw]);

  const maxId = useMemo(() => {
    if (!maxIdRaw.trim()) return 0x1fffffff;
    const n = parseInt(maxIdRaw, 16);
    return isNaN(n) ? null : n;
  }, [maxIdRaw]);

  // Composite keys whose numeric frame ID falls within the range, sorted ascending
  const matchingIds = useMemo(() => {
    if (minId === null || maxId === null) return [];
    return Array.from(frameInfoMap.keys())
      .map((fk) => ({ fk, numId: parseFrameKey(fk).frameId }))
      .filter(({ numId }) => numId >= minId && numId <= maxId)
      .sort((a, b) => a.numId - b.numId);
  }, [frameInfoMap, minId, maxId]);

  const rangeError =
    (minIdRaw.trim() && minId === null) || (maxIdRaw.trim() && maxId === null)
      ? "Invalid hex value"
      : minId !== null && maxId !== null && minId > maxId
      ? "Min must be ≤ Max"
      : null;

  const canConfirm = !!transmitSession && matchingIds.length > 0 && !rangeError;

  const handleConfirm = () => {
    if (!transmitSession || matchingIds.length === 0) return;

    // Build last-seen bytes for each matching numeric ID by scanning the buffer once (O(n))
    const matchingNumericSet = new Set(matchingIds.map(m => m.numId));
    const lastSeenMap = new Map<
      number,
      { bytes: number[]; is_extended: boolean; dlc: number }
    >();
    for (const f of getDiscoveryFrameBuffer()) {
      if (matchingNumericSet.has(f.frame_id)) {
        lastSeenMap.set(f.frame_id, {
          bytes: f.bytes,
          is_extended: f.is_extended ?? false,
          dlc: f.dlc,
        });
      }
    }

    const frames = matchingIds.map(({ fk, numId }) => {
      const seen = lastSeenMap.get(numId);
      const info = frameInfoMap.get(fk);
      const dlc = seen?.dlc ?? info?.len ?? 8;
      return {
        frame_id: numId,
        bytes: seen ? [...seen.bytes] : new Array(dlc).fill(0),
        bus,
        is_extended: seen?.is_extended ?? info?.isExtended ?? numId > 0x7ff,
        dlc,
      };
    });

    addCanFramesBulk(
      frames,
      transmitSession.profileId,
      transmitSession.profileName,
      intervalMs,
      groupName.trim() || undefined
    );
    useTransmitStore.getState().setActiveTab("queue");
    openPanel("transmit");
    onClose();
  };

  const totalKnown = frameInfoMap.size;

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-sm">
      <div className="p-6 space-y-4">
        <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
          Add to Transmit Queue
        </h2>

        {/* Session info */}
        <div className="space-y-1">
          <label className={labelSmall}>Target session</label>
          {transmitSession ? (
            <p className="text-sm text-[color:var(--text-primary)] font-medium">
              {transmitSession.profileName}
            </p>
          ) : (
            <p className="text-sm text-[color:var(--status-danger-text)]">
              Transmit is not connected. Connect a session in the Transmit panel first.
            </p>
          )}
        </div>

        {/* Bus picker — only shown for multi-bus sessions */}
        {availableBuses.length > 1 && (
          <div className="space-y-1">
            <label className={labelSmall}>Output bus</label>
            <select
              value={bus}
              onChange={(e) => setBus(Number(e.target.value))}
              className={inputSimple}
            >
              {availableBuses.map((b) => (
                <option key={b} value={b}>
                  Bus {b}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Frame ID range */}
        <div className="space-y-2">
          <label className={labelSmall}>Frame ID range (hex)</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={minIdRaw}
              onChange={(e) => setMinIdRaw(e.target.value.toUpperCase())}
              placeholder="Min (e.g. 100)"
              className={`${inputSimple} flex-1 font-mono text-sm`}
              maxLength={8}
            />
            <span className="text-[color:var(--text-secondary)] text-sm">–</span>
            <input
              type="text"
              value={maxIdRaw}
              onChange={(e) => setMaxIdRaw(e.target.value.toUpperCase())}
              placeholder="Max (e.g. 7FF)"
              className={`${inputSimple} flex-1 font-mono text-sm`}
              maxLength={8}
            />
            <button
              onClick={() => { setMinIdRaw(""); setMaxIdRaw(""); }}
              className="px-2.5 py-1.5 text-xs rounded border border-[color:var(--border-default)] text-[color:var(--text-secondary)] hover:brightness-95 transition-colors whitespace-nowrap"
            >
              All
            </button>
          </div>
          {rangeError ? (
            <p className="text-xs text-[color:var(--status-danger-text)]">{rangeError}</p>
          ) : (
            <p className={helpText}>
              {matchingIds.length > 0
                ? `${matchingIds.length} of ${totalKnown} frame ID${totalKnown !== 1 ? "s" : ""} selected`
                : totalKnown > 0
                ? "No frame IDs match this range"
                : "No frames captured yet"}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label className={labelSmall}>Repeat interval (ms)</label>
          <input
            type="number"
            min={10}
            max={60000}
            step={10}
            value={intervalMs}
            onChange={(e) => setIntervalMs(Math.max(10, Number(e.target.value)))}
            className={inputSimple}
          />
          <p className={helpText}>Used when you start repeat on a queue item.</p>
        </div>

        <div className="space-y-1">
          <label className={labelSmall}>Group (optional)</label>
          <input
            type="text"
            list="bulk-add-groups"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="e.g. Diagnostics"
            className={inputSimple}
          />
          <datalist id="bulk-add-groups">
            {getGroupNames().map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <p className={helpText}>Assign all frames to a group for sequence repeat.</p>
        </div>

        <DialogFooter
          onCancel={onClose}
          onConfirm={handleConfirm}
          confirmLabel={
            matchingIds.length > 0
              ? `Add ${matchingIds.length} to Queue`
              : "Add to Queue"
          }
          confirmDisabled={!canConfirm}
        />
      </div>
    </Dialog>
  );
}

// ui/src/apps/transmit/views/TransmitQueueView.tsx
//
// Queue management view for repeat transmit.
// Supports individual item repeat and group repeat (multiple items in sequence).

import { useCallback, useMemo } from "react";
import { Play, Square, Trash2, StopCircle, Settings, Users } from "lucide-react";
import { useTransmitStore } from "../../../stores/transmitStore";
import { useActiveSession } from "../../../stores/sessionStore";
import {
  bgDataToolbar,
  borderDataView,
  textDataPrimary,
  bgDataInput,
  textDataSecondary,
  hoverDataRow,
} from "../../../styles/colourTokens";
import {
  buttonBase,
  dangerButtonBase,
  playButtonCompact,
  stopButtonCompact,
  paginationButtonDark,
} from "../../../styles/buttonStyles";
import { flexRowGap2 } from "../../../styles/spacing";
import { byteToHex } from "../../../utils/byteUtils";

export default function TransmitQueueView() {
  // Store selectors
  const queue = useTransmitStore((s) => s.queue);
  const activeSession = useActiveSession();
  const activeGroups = useTransmitStore((s) => s.activeGroups);

  // Store actions
  const removeFromQueue = useTransmitStore((s) => s.removeFromQueue);
  const clearQueue = useTransmitStore((s) => s.clearQueue);
  const startRepeat = useTransmitStore((s) => s.startRepeat);
  const stopRepeat = useTransmitStore((s) => s.stopRepeat);
  const stopAllRepeats = useTransmitStore((s) => s.stopAllRepeats);
  const updateQueueInterval = useTransmitStore((s) => s.updateQueueInterval);
  const toggleQueueEnabled = useTransmitStore((s) => s.toggleQueueEnabled);
  const setItemGroup = useTransmitStore((s) => s.setItemGroup);
  const startGroupRepeat = useTransmitStore((s) => s.startGroupRepeat);
  const stopGroupRepeat = useTransmitStore((s) => s.stopGroupRepeat);
  const stopAllGroupRepeats = useTransmitStore((s) => s.stopAllGroupRepeats);


  // Compute first item index for each group (for showing group controls)
  const firstItemInGroup = useMemo(() => {
    const result = new Map<string, string>(); // groupName -> first item id
    for (const item of queue) {
      if (item.groupName && !result.has(item.groupName)) {
        result.set(item.groupName, item.id);
      }
    }
    return result;
  }, [queue]);

  // Check if any item is repeating
  const hasActiveRepeats = queue.some((item) => item.isRepeating);
  const hasActiveGroupRepeats = activeGroups.size > 0;

  // Handle stop all (both individual and group repeats)
  const handleStopAll = useCallback(async () => {
    // Stop individual repeats
    await stopAllRepeats();
    // Stop group repeats
    await stopAllGroupRepeats();
  }, [stopAllRepeats, stopAllGroupRepeats]);

  // Handle clear queue
  const handleClearQueue = useCallback(async () => {
    await clearQueue();
  }, [clearQueue]);

  // Handle play/stop for individual item (non-grouped)
  const handleToggleRepeat = useCallback(
    async (queueId: string, isRepeating: boolean) => {
      if (isRepeating) {
        await stopRepeat(queueId);
      } else {
        await startRepeat(queueId);
      }
    },
    [startRepeat, stopRepeat]
  );

  // Handle play/stop for group
  const handleToggleGroupRepeat = useCallback(
    async (groupName: string) => {
      if (activeGroups.has(groupName)) {
        await stopGroupRepeat(groupName);
      } else {
        await startGroupRepeat(groupName);
      }
    },
    [activeGroups, startGroupRepeat, stopGroupRepeat]
  );

  // Handle group name change
  const handleGroupChange = useCallback(
    (queueId: string, value: string) => {
      setItemGroup(queueId, value.trim() || undefined);
    },
    [setItemGroup]
  );

  // Handle remove item
  const handleRemove = useCallback(
    (queueId: string) => {
      removeFromQueue(queueId);
    },
    [removeFromQueue]
  );

  // Handle interval change
  const handleIntervalChange = useCallback(
    (queueId: string, value: string) => {
      const interval = parseInt(value, 10);
      if (!isNaN(interval) && interval >= 1) {
        updateQueueInterval(queueId, interval);
      }
    },
    [updateQueueInterval]
  );

  // Format frame for display
  const formatFrame = (item: (typeof queue)[0]) => {
    if (item.type === "can" && item.canFrame) {
      const frame = item.canFrame;
      const idStr = frame.is_extended
        ? `0x${frame.frame_id.toString(16).toUpperCase().padStart(8, "0")}`
        : `0x${frame.frame_id.toString(16).toUpperCase().padStart(3, "0")}`;
      const dataStr = frame.data.map(byteToHex).join(" ");
      return {
        type: "CAN",
        id: idStr,
        details: `[${frame.data.length}] ${dataStr}`,
        flags: [
          frame.is_extended && "EXT",
          frame.is_fd && "FD",
          frame.is_brs && "BRS",
          frame.is_rtr && "RTR",
        ].filter((f): f is string => Boolean(f)),
        bus: frame.bus,
      };
    } else if (item.type === "serial" && item.serialBytes) {
      const dataStr = item.serialBytes.slice(0, 8).map(byteToHex).join(" ");
      const truncated = item.serialBytes.length > 8 ? "..." : "";
      return {
        type: "Serial",
        id: null,
        details: `[${item.serialBytes.length}] ${dataStr}${truncated}`,
        flags: item.framingMode ? [item.framingMode.toUpperCase()] : [],
        bus: null,
      };
    }
    return null;
  };

  // Empty state
  if (queue.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
        <div className={`${textDataSecondary} text-center`}>
          <p className="text-lg font-medium">Queue Empty</p>
          <p className="text-sm mt-2">
            Add frames from the CAN or Serial tab to build a transmit queue.
          </p>
          <p className="text-xs mt-1 text-gray-500">
            Queue items can repeat at configurable intervals.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className={`flex items-center gap-3 px-4 py-2 ${bgDataToolbar} border-b ${borderDataView}`}
      >
        <span className={`${textDataSecondary} text-sm`}>
          {queue.length} item{queue.length !== 1 ? "s" : ""} in queue
        </span>

        <div className="flex-1" />

        {(hasActiveRepeats || hasActiveGroupRepeats) && (
          <button
            onClick={handleStopAll}
            className={dangerButtonBase}
            title="Stop all repeats"
          >
            <StopCircle size={14} />
            <span className="text-sm ml-1">Stop All</span>
          </button>
        )}

        <button
          onClick={handleClearQueue}
          className={buttonBase}
          title="Clear queue"
        >
          <Trash2 size={14} />
          <span className="text-sm ml-1">Clear</span>
        </button>
      </div>

      {/* Queue Items */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead
            className={`${bgDataToolbar} sticky top-0 ${textDataSecondary} text-xs`}
          >
            <tr>
              <th className="text-left px-4 py-2 w-12"></th>
              <th className="text-left px-4 py-2">Interface</th>
              <th className="text-left px-4 py-2 w-16">Type</th>
              <th className="text-left px-4 py-2">Frame / Data</th>
              <th className="text-left px-4 py-2 w-24">Interval</th>
              <th className="text-left px-4 py-2 w-28">Group</th>
              <th className="text-left px-4 py-2 w-24">Actions</th>
            </tr>
          </thead>
          <tbody>
            {queue.map((item) => {
              const formatted = formatFrame(item);
              if (!formatted) return null;

              // Group state
              const isInGroup = Boolean(item.groupName);
              const isGroupRepeating = item.groupName ? activeGroups.has(item.groupName) : false;
              const isFirstInGroup = item.groupName ? firstItemInGroup.get(item.groupName) === item.id : false;

              // All repeat requires IO session with transmit capability
              // For CAN items, check can_transmit; for serial items, check can_transmit_serial
              const hasCanTransmit = Boolean(activeSession?.capabilities?.can_transmit);
              const hasSerialTransmit = Boolean(activeSession?.capabilities?.can_transmit_serial);
              const hasIOSession = item.type === "serial" ? hasSerialTransmit : hasCanTransmit;
              const canStartIndividual = !isInGroup && item.enabled && !item.isRepeating && hasIOSession;
              const canStartGroup = isInGroup && isFirstInGroup && item.enabled && !isGroupRepeating && hasCanTransmit;

              return (
                <tr
                  key={item.id}
                  className={`border-b ${borderDataView} ${hoverDataRow} ${
                    !item.enabled ? "opacity-50" : ""
                  } ${isInGroup && isGroupRepeating ? "bg-green-900/20" : ""}`}
                >
                  {/* Play/Stop */}
                  <td className="px-4 py-2">
                    {isInGroup ? (
                      // Grouped item: show group play/stop on first item only
                      isFirstInGroup ? (
                        isGroupRepeating ? (
                          <button
                            onClick={() => handleToggleGroupRepeat(item.groupName!)}
                            className={stopButtonCompact}
                            title={`Stop group '${item.groupName}'`}
                          >
                            <Square size={12} fill="currentColor" />
                          </button>
                        ) : (
                          <button
                            onClick={() => handleToggleGroupRepeat(item.groupName!)}
                            disabled={!canStartGroup}
                            className={playButtonCompact}
                            title={
                              !hasIOSession
                                ? "Group repeat requires an IO session (start Discovery or Decoder first)"
                                : `Start group '${item.groupName}'`
                            }
                          >
                            <Play size={12} fill="currentColor" />
                          </button>
                        )
                      ) : (
                        // Not first in group: show indicator only
                        <span className="text-gray-600" title="Controlled by group">
                          <Users size={12} />
                        </span>
                      )
                    ) : (
                      // Individual item: normal play/stop
                      item.isRepeating ? (
                        <button
                          onClick={() => handleToggleRepeat(item.id, true)}
                          className={stopButtonCompact}
                          title="Stop repeat"
                        >
                          <Square size={12} fill="currentColor" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleToggleRepeat(item.id, false)}
                          disabled={!canStartIndividual}
                          className={playButtonCompact}
                          title={
                            !hasIOSession
                              ? "Requires an IO session (connect via the CAN tab)"
                              : "Start repeat"
                          }
                        >
                          <Play size={12} fill="currentColor" />
                        </button>
                      )
                    )}
                  </td>

                  {/* Interface */}
                  <td className="px-4 py-2">
                    <span className="text-gray-300">{item.profileName}</span>
                  </td>

                  {/* Type */}
                  <td className="px-4 py-2">
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${
                        formatted.type === "CAN"
                          ? "bg-blue-600/30 text-blue-400"
                          : "bg-purple-600/30 text-purple-400"
                      }`}
                    >
                      {formatted.type}
                    </span>
                  </td>

                  {/* Frame / Data */}
                  <td className="px-4 py-2">
                    <div className={flexRowGap2}>
                      {formatted.id && (
                        <code className="font-mono text-green-400">
                          {formatted.id}
                        </code>
                      )}
                      {formatted.bus !== null && formatted.bus !== undefined && (
                        <span className="text-xs text-amber-400">
                          Bus {formatted.bus}
                        </span>
                      )}
                      <code className="font-mono text-gray-400 text-xs">
                        {formatted.details}
                      </code>
                      {formatted.flags.map((flag) => (
                        <span
                          key={flag}
                          className="text-[10px] text-amber-400 uppercase"
                        >
                          {flag}
                        </span>
                      ))}
                    </div>
                  </td>

                  {/* Interval */}
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={item.repeatIntervalMs}
                        onChange={(e) =>
                          handleIntervalChange(item.id, e.target.value)
                        }
                        disabled={item.isRepeating || isGroupRepeating}
                        min={1}
                        className={`w-16 ${bgDataInput} ${textDataPrimary} text-xs rounded px-1.5 py-1 border ${borderDataView} focus:outline-none focus:border-blue-500 disabled:opacity-50`}
                      />
                      <span className={`${textDataSecondary} text-xs`}>ms</span>
                    </div>
                  </td>

                  {/* Group */}
                  <td className="px-4 py-2">
                    <input
                      type="text"
                      value={item.groupName ?? ""}
                      onChange={(e) => handleGroupChange(item.id, e.target.value)}
                      disabled={item.isRepeating || isGroupRepeating}
                      placeholder="—"
                      className={`w-20 ${bgDataInput} ${textDataPrimary} text-xs rounded px-1.5 py-1 border ${borderDataView} focus:outline-none focus:border-blue-500 disabled:opacity-50 placeholder:text-gray-600`}
                      title="Group name (items with same group transmit together)"
                    />
                  </td>

                  {/* Actions */}
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => toggleQueueEnabled(item.id)}
                        className={paginationButtonDark}
                        title={item.enabled ? "Disable" : "Enable"}
                      >
                        <Settings
                          size={14}
                          className={item.enabled ? "" : "text-gray-600"}
                        />
                      </button>
                      <button
                        onClick={() => handleRemove(item.id)}
                        disabled={item.isRepeating}
                        className={`${paginationButtonDark} hover:text-red-400`}
                        title="Remove from queue"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

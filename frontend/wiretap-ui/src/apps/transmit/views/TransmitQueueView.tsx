// ui/src/apps/transmit/views/TransmitQueueView.tsx
//
// Queue management view for repeat transmit.
// Supports individual item repeat and group repeat (multiple items in sequence).

import { useCallback, useMemo } from "react";
import { Play, Square, Trash2, StopCircle, Users, AlertCircle, Link } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTransmitStore, GVRET_BUSES } from "../../../stores/transmitStore";
import { useActiveSession, useSessionStore, type BusSourceInfo } from "../../../stores/sessionStore";
import {
  bgSurface,
  bgDataView,
  bgSuccess,
  borderDefault,
  textDataAmber,
  textDataGreen,
  textDataMuted,
  textSecondary,
  textWarning,
} from "../../../styles/colourTokens";
import { Badge } from "../../../components/Badge";
import { flexRowGap2 } from "../../../styles/spacing";
import { emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription, emptyStateHint } from "../../../styles/typography";
import { byteToHex } from "../../../utils/byteUtils";
import { formatBusLabel } from "../../../utils/busFormat";
import { resolveQueueItemSession } from "../../../stores/transmitRowSession";
import { Button, IconButton } from "../../../components/Button";
import { Select, Input, Checkbox } from "../../../components/forms";
import { Table } from "../../../components/Table";

interface TransmitQueueViewProps {
  outputBusToSource: Map<number, BusSourceInfo>;
}

export default function TransmitQueueView({ outputBusToSource }: TransmitQueueViewProps) {
  const { t } = useTranslation("transmit");
  // Store selectors
  const queue = useTransmitStore((s) => s.queue);
  const activeSession = useActiveSession();
  const activeGroups = useTransmitStore((s) => s.activeGroups);
  const sessions = useSessionStore((s) => s.sessions);

  // Store actions
  const removeFromQueue = useTransmitStore((s) => s.removeFromQueue);
  const clearQueue = useTransmitStore((s) => s.clearQueue);
  const startRepeat = useTransmitStore((s) => s.startRepeat);
  const stopRepeat = useTransmitStore((s) => s.stopRepeat);
  const stopAllRepeats = useTransmitStore((s) => s.stopAllRepeats);
  const updateQueueInterval = useTransmitStore((s) => s.updateQueueInterval);
  const toggleQueueEnabled = useTransmitStore((s) => s.toggleQueueEnabled);
  const updateQueueItemBus = useTransmitStore((s) => s.updateQueueItemBus);
  const updateQueueItemSession = useTransmitStore((s) => s.updateQueueItemSession);
  const setItemGroup = useTransmitStore((s) => s.setItemGroup);
  const startGroupRepeat = useTransmitStore((s) => s.startGroupRepeat);
  const stopGroupRepeat = useTransmitStore((s) => s.stopGroupRepeat);
  const stopAllGroupRepeats = useTransmitStore((s) => s.stopAllGroupRepeats);


  // Compute first enabled item in each group (for showing group controls)
  // The play button appears on the first enabled item, so groups remain controllable
  // even if the first item is disabled
  const firstEnabledInGroup = useMemo(() => {
    const result = new Map<string, string>(); // groupName -> first enabled item id
    for (const item of queue) {
      if (item.groupName && item.enabled && !result.has(item.groupName)) {
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
      <div className={emptyStateContainer}>
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>{t("queue.emptyHeading")}</p>
          <p className={emptyStateDescription}>
            Add frames from the CAN or Serial tab to build a transmit queue.
          </p>
          <p className={emptyStateHint}>
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
        className={`flex items-center gap-3 px-4 py-2 ${bgSurface} border-b ${borderDefault}`}
      >
        <span className={`${textSecondary} text-sm`}>
          {queue.length} item{queue.length !== 1 ? "s" : ""} in queue
        </span>

        <div className="flex-1" />

        {(hasActiveRepeats || hasActiveGroupRepeats) && (
          <Button
            onClick={handleStopAll}
            variant="solid"
            tone="danger"
            title={t("queue.stopAllTooltip")}
          >
            <StopCircle size={14} />
            {t("queue.stopAllLabel")}
          </Button>
        )}

        <Button
          onClick={handleClearQueue}
          title={t("queue.clearTooltip")}
        >
          <Trash2 size={14} />
          <span className="text-sm ml-1">{t("queue.clearLabel")}</span>
        </Button>
      </div>

      {/* Queue Items */}
      <div className={`flex-1 overflow-auto ${bgDataView}`}>
        <Table sticky hover>
          <thead>
            <tr>
              <th className="w-12" />
              <th className="w-28">{t("queue.columns.bus")}</th>
              <th className="w-16">{t("queue.columns.type")}</th>
              <th>Frame / Data</th>
              <th className="w-24">{t("queue.columns.interval")}</th>
              <th className="w-28">{t("queue.columns.group")}</th>
              <th className="w-24">{t("queue.columns.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {queue.map((item) => {
              const formatted = formatFrame(item);
              if (!formatted) return null;

              // Group state
              const isInGroup = Boolean(item.groupName);
              const isGroupRepeating = item.groupName ? activeGroups.has(item.groupName) : false;
              const isFirstEnabledInGroup = item.groupName ? firstEnabledInGroup.get(item.groupName) === item.id : false;

              // Check item's session state (not active session)
              const itemSession = resolveQueueItemSession(item, sessions);
              const isOrphaned = !itemSession || itemSession.lifecycleState === "disconnected";
              const isItemSessionConnected = itemSession?.lifecycleState === "connected";

              // All repeat requires IO session with transmit capability
              // For CAN items, check can_transmit; for serial items, check can_transmit_serial
              const hasCanTransmit = isItemSessionConnected && Boolean(itemSession?.capabilities?.traits.tx_frames);
              const hasSerialTransmit = isItemSessionConnected && Boolean(itemSession?.capabilities?.traits.tx_bytes);
              const hasIOSession = item.type === "serial" ? hasSerialTransmit : hasCanTransmit;
              const canStartIndividual = !isInGroup && item.enabled && !item.isRepeating && hasIOSession;
              const canStartGroup = isInGroup && isFirstEnabledInGroup && item.enabled && !isGroupRepeating && hasCanTransmit;

              return (
                <tr key={item.id} className={isInGroup && isGroupRepeating ? bgSuccess : ""}>
                  {/* Play/Stop */}
                  <td>
                    {isInGroup ? (
                      // Grouped item: show group play/stop on first item only
                      isFirstEnabledInGroup ? (
                        isGroupRepeating ? (
                          <Button
                            onClick={() => handleToggleGroupRepeat(item.groupName!)}
                            variant="solid"
                            tone="danger"
                            size="sm"
                            title={`Stop group '${item.groupName}'`}
                          >
                            <Square size={12} fill="currentColor" />
                          </Button>
                        ) : (
                          <Button
                            onClick={() => handleToggleGroupRepeat(item.groupName!)}
                            disabled={!canStartGroup}
                            variant="solid"
                            tone="success"
                            size="sm"
                            title={
                              !hasIOSession
                                ? "Group repeat requires an IO session (start Discovery or Decoder first)"
                                : `Start group '${item.groupName}'`
                            }
                          >
                            <Play size={12} fill="currentColor" />
                          </Button>
                        )
                      ) : (
                        // Not first in group: show indicator only
                        <span className={textDataMuted} title={t("queue.actions.controlledByGroup")}>
                          <Users size={12} />
                        </span>
                      )
                    ) : (
                      // Individual item: normal play/stop
                      item.isRepeating ? (
                        <Button
                          onClick={() => handleToggleRepeat(item.id, true)}
                          variant="solid"
                          tone="danger"
                          size="sm"
                          title={t("queue.actions.stopRepeatTooltip")}
                        >
                          <Square size={12} fill="currentColor" />
                        </Button>
                      ) : (
                        <Button
                          onClick={() => handleToggleRepeat(item.id, false)}
                          disabled={!canStartIndividual}
                          variant="solid"
                          tone="success"
                          size="sm"
                          title={
                            !hasIOSession
                              ? "Requires an IO session (connect via the CAN tab)"
                              : t("queue.actions.startRepeatTooltip")
                          }
                        >
                          <Play size={12} fill="currentColor" />
                        </Button>
                      )
                    )}
                  </td>

                  {/* Bus */}
                  <td>
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1.5">
                        {isOrphaned && (
                          <span className={textWarning} title={t("queue.actions.sessionDisconnected")}>
                            <AlertCircle size={12} />
                          </span>
                        )}
                        <span
                          className={`${textSecondary} text-xs truncate max-w-25`}
                          title={formatBusLabel(item.profileName, item.canFrame?.bus, outputBusToSource)}
                        >
                          {formatBusLabel(item.profileName, item.canFrame?.bus, outputBusToSource)}
                        </span>
                        {item.origin === "agent" && (
                          <Badge tone="primary" size="sm" className="uppercase tracking-wide" title={t("queue.agentRepeat")}>
                            {t("queue.agentBadge")}
                          </Badge>
                        )}
                      </div>
                      {item.type === "can" && item.canFrame && (
                        <Select
                          value={item.canFrame.bus}
                          onChange={(e) =>
                            updateQueueItemBus(item.id, parseInt(e.target.value))
                          }
                          disabled={item.isRepeating || isGroupRepeating}
                          size="sm"
                          className="w-16"
                        >
                          {GVRET_BUSES.map((b) => (
                            <option key={b.value} value={b.value}>
                              {b.label}
                            </option>
                          ))}
                        </Select>
                      )}
                    </div>
                  </td>

                  {/* Type */}
                  <td>
                    <Badge tone={formatted.type === "CAN" ? "primary" : "purple"}>
                      {formatted.type}
                    </Badge>
                  </td>

                  {/* Frame / Data */}
                  <td>
                    <div className={flexRowGap2}>
                      {formatted.id && (
                        <code className={`font-mono ${textDataGreen}`}>
                          {formatted.id}
                        </code>
                      )}
                      <code className={`font-mono text-xs ${textSecondary}`}>
                        {formatted.details}
                      </code>
                      {formatted.flags.map((flag) => (
                        <span
                          key={flag}
                          className={`text-2xs uppercase ${textDataAmber}`}
                        >
                          {flag}
                        </span>
                      ))}
                    </div>
                  </td>

                  {/* Interval */}
                  <td>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        value={item.repeatIntervalMs}
                        onChange={(e) =>
                          handleIntervalChange(item.id, e.target.value)
                        }
                        disabled={item.isRepeating || isGroupRepeating}
                        min={1}
                        size="sm"
                        className="w-16"
                      />
                      <span className={`${textSecondary} text-xs`}>ms</span>
                    </div>
                  </td>

                  {/* Group */}
                  <td>
                    <Input
                      type="text"
                      value={item.groupName ?? ""}
                      onChange={(e) => handleGroupChange(item.id, e.target.value)}
                      disabled={item.isRepeating || isGroupRepeating}
                      placeholder={t("queue.groupPlaceholder")}
                      size="sm"
                      className="w-20"
                      title={t("queue.groupTooltip")}
                    />
                  </td>

                  {/* Actions */}
                  <td>
                    <div className="flex items-center gap-1.5">
                      <Checkbox
                        checked={item.enabled}
                        onChange={() => toggleQueueEnabled(item.id)}
                        disabled={item.isRepeating || isGroupRepeating}
                        size="sm"
                        title={item.enabled ? t("queue.actions.disableItem") : t("queue.actions.enableItem")}
                      />
                      {isOrphaned && activeSession && (
                        <IconButton
                          onClick={() =>
                            updateQueueItemSession(
                              item.id,
                              activeSession.profileId,
                              activeSession.profileName
                            )
                          }
                          size="sm"
                          title={`Assign to ${activeSession.profileName}`}
                        >
                          <Link size={14} />
                        </IconButton>
                      )}
                      <IconButton
                        onClick={() => handleRemove(item.id)}
                        disabled={item.isRepeating}
                        tone="danger"
                        size="sm"
                        title={t("queue.actions.removeFromQueue")}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

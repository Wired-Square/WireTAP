// ui/src/apps/transmit/views/TransmitQueueView.tsx
//
// Queue management view for repeat transmit.
// Supports individual item repeat and group repeat (multiple items in sequence).

import { useCallback, useMemo, type ComponentProps } from "react";
import { Play, Square, Trash2, StopCircle, Users, AlertCircle, Link } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTransmitStore, GVRET_BUSES } from "../../../stores/transmitStore";
import { useActiveSession, useSessionStore, type BusSourceInfo } from "../../../stores/sessionStore";
import {
  bgSurface,
  bgDataView,
  bgSuccess,
  borderDefault,
  textDanger,
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
import { Button, IconButton } from "../../../components/Button";
import { Select, Input, Checkbox } from "../../../components/forms";
import { Table } from "../../../components/Table";
import type { QueueRow } from "../../../api/transmit";

/**
 * An input over a value Rust holds: edits stay local while typing and go to Rust
 * on blur or Enter, so a push in between cannot overwrite a half-typed value.
 * It shows Rust's value until the push, so a refused edit reverts.
 */
function CommitInput({ value, onCommit, ...props }: Omit<ComponentProps<typeof Input>, "value" | "defaultValue"> & {
  value: string;
  onCommit: (value: string) => void;
}) {
  return (
    <Input
      {...props}
      key={value}
      defaultValue={value}
      onBlur={(e) => {
        if (e.target.value === value) return;
        onCommit(e.target.value);
        e.target.value = value;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

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
  const editQueueRow = useTransmitStore((s) => s.editQueueRow);
  const startGroupRepeat = useTransmitStore((s) => s.startGroupRepeat);
  const stopGroupRepeat = useTransmitStore((s) => s.stopGroupRepeat);


  // Compute first enabled item in each group (for showing group controls)
  // The play button appears on the first enabled item, so groups remain controllable
  // even if the first item is disabled
  const firstEnabledInGroup = useMemo(() => {
    const result = new Map<string, string>(); // groupName -> first enabled item id
    for (const item of queue) {
      if (item.group && item.enabled && !result.has(item.group)) {
        result.set(item.group, item.id);
      }
    }
    return result;
  }, [queue]);

  // Check if any item is repeating
  const hasActiveRepeats = queue.some((item) => item.repeating) || activeGroups.size > 0;

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


  // Handle remove item
  const handleRemove = useCallback(
    (queueId: string) => {
      removeFromQueue(queueId);
    },
    [removeFromQueue]
  );

  // Format frame for display
  const formatFrame = ({ payload }: QueueRow) => {
    if (payload.kind === "can") {
      const { frame } = payload;
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
    }
    const { bytes, framing } = payload;
    const dataStr = bytes.slice(0, 8).map(byteToHex).join(" ");
    const truncated = bytes.length > 8 ? "..." : "";
    return {
      type: "Serial",
      id: null,
      details: `[${bytes.length}] ${dataStr}${truncated}`,
      flags: framing.mode !== "raw" ? [framing.mode.toUpperCase()] : [],
      bus: null,
    };
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

        {hasActiveRepeats && (
          <Button
            onClick={stopAllRepeats}
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
              const canFrame = item.payload.kind === "can" ? item.payload.frame : null;

              // Group state
              const isInGroup = Boolean(item.group);
              const isGroupRepeating = item.group ? activeGroups.has(item.group) : false;
              const isFirstEnabledInGroup = item.group ? firstEnabledInGroup.get(item.group) === item.id : false;
              const locked = item.repeating || isGroupRepeating;

              // Check item's session state (not active session)
              const itemSession = sessions[item.session_id];
              const isOrphaned = !itemSession || itemSession.lifecycleState === "disconnected";
              const isItemSessionConnected = itemSession?.lifecycleState === "connected";

              // All repeat requires IO session with transmit capability
              // For CAN items, check can_transmit; for serial items, check can_transmit_serial
              const hasCanTransmit = isItemSessionConnected && Boolean(itemSession?.capabilities?.traits.tx_frames);
              const hasSerialTransmit = isItemSessionConnected && Boolean(itemSession?.capabilities?.traits.tx_bytes);
              const hasIOSession = canFrame ? hasCanTransmit : hasSerialTransmit;
              const canStartIndividual = !isInGroup && item.enabled && !item.repeating && hasIOSession;
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
                            onClick={() => handleToggleGroupRepeat(item.group!)}
                            variant="solid"
                            tone="danger"
                            size="sm"
                            title={`Stop group '${item.group}'`}
                          >
                            <Square size={12} fill="currentColor" />
                          </Button>
                        ) : (
                          <Button
                            onClick={() => handleToggleGroupRepeat(item.group!)}
                            disabled={!canStartGroup}
                            variant="solid"
                            tone="success"
                            size="sm"
                            title={
                              !hasIOSession
                                ? "Group repeat requires an IO session (start Discovery or Decoder first)"
                                : `Start group '${item.group}'`
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
                      item.repeating ? (
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
                        {item.last_error && (
                          <span className={textDanger} title={item.last_error}>
                            <AlertCircle size={12} />
                          </span>
                        )}
                        <span
                          className={`${textSecondary} text-xs truncate max-w-25`}
                          title={formatBusLabel(item.profile_name, canFrame?.bus, outputBusToSource)}
                        >
                          {formatBusLabel(item.profile_name, canFrame?.bus, outputBusToSource)}
                        </span>
                        {item.origin === "agent" && (
                          <Badge tone="primary" size="sm" className="uppercase tracking-wide" title={t("queue.agentRepeat")}>
                            {t("queue.agentBadge")}
                          </Badge>
                        )}
                      </div>
                      {canFrame && (
                        <Select
                          value={canFrame.bus}
                          onChange={(e) => editQueueRow(item.id, { bus: parseInt(e.target.value) })}
                          disabled={locked}
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
                      <CommitInput
                        type="number"
                        value={String(item.interval_ms)}
                        onCommit={(value) => editQueueRow(item.id, { interval_ms: parseInt(value, 10) || 0 })}
                        disabled={locked}
                        min={1}
                        size="sm"
                        className="w-16"
                      />
                      <span className={`${textSecondary} text-xs`}>ms</span>
                    </div>
                  </td>

                  {/* Group */}
                  <td>
                    <CommitInput
                      type="text"
                      value={item.group ?? ""}
                      onCommit={(group) => editQueueRow(item.id, { group })}
                      disabled={locked}
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
                        onChange={() => editQueueRow(item.id, { enabled: !item.enabled })}
                        disabled={locked}
                        size="sm"
                        title={item.enabled ? t("queue.actions.disableItem") : t("queue.actions.enableItem")}
                      />
                      {isOrphaned && activeSession && (
                        <IconButton
                          onClick={() =>
                            editQueueRow(item.id, {
                              session: {
                                session_id: activeSession.id,
                                profile_id: activeSession.profileId,
                                profile_name: activeSession.profileName,
                              },
                            })
                          }
                          size="sm"
                          title={`Assign to ${activeSession.profileName}`}
                        >
                          <Link size={14} />
                        </IconButton>
                      )}
                      <IconButton
                        onClick={() => handleRemove(item.id)}
                        disabled={item.repeating}
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

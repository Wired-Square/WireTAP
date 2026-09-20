// src/apps/events/views/EventListView.tsx

import { Crosshair, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CaptureEvent } from "../../../api/captureEvents";
import { IconButton } from "../../../components/Button";
import { Table } from "../../../components/Table";
import { bgDataView, textMuted } from "../../../styles/colourTokens";
import { flexRowGap2 } from "../../../styles/spacing";
import { formatDeltaUs, formatHumanUs } from "../../../utils/timeFormat";

interface Props {
  events: CaptureEvent[];
  selectedId: string | null;
  canJump: boolean;
  useLocalTimezone: boolean;
  onSelect: (event: CaptureEvent) => void;
  onJump: (event: CaptureEvent) => void;
  onEdit: (event: CaptureEvent) => void;
  onDelete: (event: CaptureEvent) => void;
}

export default function EventListView({ events, selectedId, canJump, useLocalTimezone, onSelect, onJump, onEdit, onDelete }: Props) {
  const { t } = useTranslation("events");

  return (
    <div className={`flex-1 min-h-0 overflow-auto ${bgDataView}`}>
      <Table size="sm" sticky hover>
        <thead>
          <tr>
            <th className="w-52">{t("columns.time")}</th>
            <th className="w-28">{t("columns.duration")}</th>
            <th>{t("columns.note")}</th>
            <th className="w-28" />
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr
              key={event.id}
              aria-current={event.id === selectedId ? "true" : undefined}
              className="cursor-pointer"
              onClick={() => onSelect(event)}
              onDoubleClick={() => onJump(event)}
            >
              <td className="font-mono">{formatHumanUs(event.timestampUs, useLocalTimezone)}</td>
              <td className="font-mono">
                {event.durationUs > 0 ? formatDeltaUs(event.durationUs) : t("instant")}
              </td>
              <td className="whitespace-pre-wrap">{event.note || <span className={textMuted}>{t("untitled")}</span>}</td>
              <td className="text-right">
                <div className={`${flexRowGap2} justify-end`}>
                  {canJump && (
                    <IconButton size="xs" label={t("actions.jump")} onClick={(e) => { e.stopPropagation(); onJump(event); }}>
                      <Crosshair size={14} />
                    </IconButton>
                  )}
                  <IconButton size="xs" label={t("actions.edit")} onClick={(e) => { e.stopPropagation(); onEdit(event); }}>
                    <Pencil size={14} />
                  </IconButton>
                  <IconButton size="xs" tone="danger" label={t("actions.delete")} onClick={(e) => { e.stopPropagation(); onDelete(event); }}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

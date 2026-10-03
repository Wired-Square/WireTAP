// A session's CAN buses in trouble, as Rust holds them: a chip per bus beside
// the session chip, and a toast for the sends a transmit timeout lost.

import { useTranslation } from "react-i18next";
import { useSessionStore } from "../stores/sessionStore";
import type { BusStatus } from "../generated/BusStatus";
import { Badge } from "./Badge";
import FlashNotification from "./FlashNotification";

const EMPTY: BusStatus[] = [];

function chip(status: BusStatus): { key: string; tone: "warning" | "danger" } {
  if (status.state === "bus_off") return { key: "busOff", tone: "danger" };
  if (status.state === "passive") return { key: "passive", tone: "danger" };
  if (status.no_ack) return { key: "noAck", tone: "warning" };
  return { key: "warning", tone: "warning" };
}

export function BusStatusBadges({ sessionId }: { sessionId: string | null | undefined }) {
  const { t } = useTranslation("common");
  const buses = useSessionStore((s) => (sessionId ? s.sessions[sessionId]?.busStatuses : undefined) ?? EMPTY);
  const multiBus = useSessionStore((s) => (sessionId ? s.sessions[sessionId]?.capabilities?.available_buses.length ?? 0 : 0) > 1);

  return buses.map((status) => {
    const { key, tone } = chip(status);
    const label = t(`busStatus.${key}`);
    const counters =
      status.tx_errors != null && status.rx_errors != null
        ? t("busStatus.counters", { tx: status.tx_errors, rx: status.rx_errors })
        : undefined;
    return (
      <Badge key={status.bus} tone={tone} title={counters} className="shrink-0">
        {multiBus ? t("busStatus.onBus", { bus: status.bus, label }) : label}
      </Badge>
    );
  });
}

export function SendsLostToasts() {
  const { t } = useTranslation("common");
  const notices = useSessionStore((s) => s.sendsLost);
  const dismiss = useSessionStore((s) => s.dismissSendsLost);

  if (notices.length === 0) return null;
  const message = notices
    .map((n) => t(n.noAck ? "busStatus.sendsLostNoAck" : "busStatus.sendsLost", { count: n.count, bus: n.bus }))
    .join(" — ");
  return <FlashNotification key={message} type="warning" duration={10000} message={message} onDismiss={dismiss} />;
}

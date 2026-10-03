// A session's CAN buses in trouble, as Rust holds them: a chip per bus beside
// the session chip, and a toast for the sends a transmit timeout lost.

import { useTranslation } from "react-i18next";
import { useSessionStore } from "../stores/sessionStore";
import type { BusStatus } from "../generated/BusStatus";
import { Badge } from "./Badge";
import FlashNotification from "./FlashNotification";

const EMPTY: BusStatus[] = [];

const STATE_KEYS: Record<BusStatus["state"], string | null> = {
  active: null,
  warning: "warning",
  passive: "passive",
  bus_off: "busOff",
};

function chip(status: BusStatus): { key: string; stateKey: string | null; tone: "warning" | "danger" } {
  const stateKey = STATE_KEYS[status.state];
  const tone = status.state === "passive" || status.state === "bus_off" ? "danger" : "warning";
  return { key: status.no_ack ? "noAck" : (stateKey ?? "warning"), stateKey, tone };
}

export function BusStatusBadges({ sessionId }: { sessionId: string | null | undefined }) {
  const { t } = useTranslation("common");
  const buses = useSessionStore((s) => (sessionId ? s.sessions[sessionId]?.busStatuses : undefined) ?? EMPTY);
  const multiBus = useSessionStore((s) => (sessionId ? s.sessions[sessionId]?.capabilities?.available_buses.length ?? 0 : 0) > 1);

  return buses.map((status) => {
    const { key, stateKey, tone } = chip(status);
    const label = t(`busStatus.${key}`);
    const counters =
      status.tx_errors != null && status.rx_errors != null
        ? t("busStatus.counters", { tx: status.tx_errors, rx: status.rx_errors })
        : null;
    const title = [stateKey && t(`busStatus.${stateKey}`), counters].filter(Boolean).join(" · ") || undefined;
    return (
      <Badge key={status.bus} tone={tone} title={title} className="shrink-0">
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

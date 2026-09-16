// ui/src/components/modbus/ModbusPollToggle.tsx
//
// One switch for a Modbus session's poller: pause the requests, keep the socket.
//
// It gates nothing else — the scan tools name their own device and run with no
// source selected. The Decoder's equivalent is a transport control with a third
// "start from stopped" state, so it keeps its own button and shares only the
// styling — see `pollButtonClass`.

import { Play, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pollButtonClass } from "../../styles/buttonStyles";

export type ModbusPollToggleProps = {
  /** Profile name of the device being polled, for the tooltip. */
  deviceName: string;
  isPolling: boolean;
  onPause: () => void;
  onResume: () => void;
};

export default function ModbusPollToggle({
  deviceName,
  isPolling,
  onPause,
  onResume,
}: ModbusPollToggleProps) {
  const { t } = useTranslation("discovery");

  const Icon = isPolling ? Square : Play;

  return (
    <button
      type="button"
      onClick={isPolling ? onPause : onResume}
      className={pollButtonClass(isPolling)}
      title={t(isPolling ? "modbusPoll.pauseTitle" : "modbusPoll.resumeTitle", { device: deviceName })}
    >
      <Icon size={10} fill="currentColor" />
      {t(isPolling ? "modbusPoll.pause" : "modbusPoll.resume")}
    </button>
  );
}

// ui/src/dialogs/AboutDialog.tsx

import { useEffect, useState } from "react";
import { X } from 'lucide-react';
import { iconLg } from "../styles/spacing";
import { getAppVersion } from "../api";
import Dialog from "../components/Dialog";
import { PrimaryButton } from "../components/forms";
import { h1, h3, bodyDefault, bodySmall, borderDefault, hoverLight, roundedDefault, spaceYDefault, paddingDialog } from "../styles";

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function AboutDialog({ isOpen, onClose }: AboutDialogProps) {
  const [version, setVersion] = useState<string>("Loading…");

  useEffect(() => {
    if (!isOpen) return;
    getAppVersion()
      .then((v) => setVersion(v))
      .catch(() => setVersion("Unknown"));
  }, [isOpen]);

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose}>
      <div className={`${paddingDialog} max-h-[80vh] flex flex-col`}>
        <div className="flex items-start justify-between mb-4 shrink-0">
          <h2 className={h1}>About WireTAP</h2>
          <button
            onClick={onClose}
            className={`p-1 ${hoverLight} ${roundedDefault} transition-colors`}
          >
            <X className={`${iconLg} text-slate-500`} />
          </button>
        </div>

        <div className={`${spaceYDefault} ${bodyDefault} overflow-y-auto min-h-0`}>
          <div className="flex flex-col items-center text-center">
            <img src="/logo.png" alt="WireTAP" className="w-14 h-14 rounded-2xl mb-2 bg-white p-1.5" />
            <p className="text-2xl font-bold font-ubuntu text-[color:var(--text-primary)]">WireTAP</p>
            <p className={`${bodySmall} font-ubuntu mt-1`}>by Wired Square</p>
            <p className={`${bodySmall} mt-1`}>Version {version}</p>
            <p className="text-xs italic opacity-50 mt-1">the artist formerly known as CANdor</p>
          </div>

          <p>
            A cross-platform toolkit for analyzing, decoding, and discovering CAN (Controller Area Network)
            bus messages, with a focus on reverse-engineering energy storage and vehicle communication protocols.
          </p>

          <div className={`pt-3 border-t ${borderDefault}`}>
            <p className={`${h3} mb-2`}>Features</p>
            <ul className={`${bodySmall} space-y-1 list-disc list-inside`}>
              <li>CAN bus analysis, decoding, and discovery</li>
              <li>Modbus TCP client/server polling</li>
              <li>Serial device communication</li>
              <li>MQTT and PostgreSQL integration</li>
              <li>Multi-source I/O with real-time streaming</li>
              <li>Signal catalogue editor</li>
              <li>Frame transmission and playback</li>
              <li>Graphing and data visualisation</li>
            </ul>
          </div>

          <div className={`pt-3 border-t ${borderDefault}`}>
            <p className={bodySmall}>
              <strong>License:</strong> MIT License
            </p>
            <p className={bodySmall}>
              <strong>Copyright:</strong> © 2026 Wired Square
            </p>
          </div>
        </div>

        <div className="pt-4 shrink-0">
          <PrimaryButton onClick={onClose} className="w-full">
            Close
          </PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}

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
      <div className={paddingDialog}>
        <div className="flex items-start justify-between mb-6">
          <h2 className={h1}>About WireTAP</h2>
          <button
            onClick={onClose}
            className={`p-1 ${hoverLight} ${roundedDefault} transition-colors`}
          >
            <X className={`${iconLg} text-slate-500`} />
          </button>
        </div>

        <div className={`${spaceYDefault} ${bodyDefault}`}>
          <div className="flex flex-col items-center text-center">
            <img src="/logo.png" alt="WireTAP" className="w-16 h-16 rounded-xl mb-3" />
            <p className="text-3xl font-bold text-[color:var(--text-primary)]">WireTAP</p>
            <p className={`${bodySmall} mt-1`}>by Wired Square</p>
            <p className={`${bodySmall} mt-2`}>Version {version}</p>
            <p className="text-xs italic opacity-50 mt-1">the artist formerly known as CANdor</p>
          </div>

          <p>
            A cross-platform toolkit for analyzing, decoding, and discovering CAN (Controller Area Network)
            bus messages, with a focus on reverse-engineering energy storage and vehicle communication protocols.
          </p>

          <div className={`pt-4 border-t ${borderDefault}`}>
            <p className={`${h3} mb-2`}>Features</p>
            <ul className={`${bodySmall} space-y-1 list-disc list-inside`}>
              <li>CAN Message Decoding</li>
              <li>Protocol Discovery</li>
              <li>Catalog Management</li>
              <li>Multi-source I/O</li>
              <li>Real-time Streaming</li>
            </ul>
          </div>

          <div className={`pt-4 border-t ${borderDefault}`}>
            <p className={bodySmall}>
              <strong>License:</strong> MIT License
            </p>
            <p className={bodySmall}>
              <strong>Copyright:</strong> © 2026 Wired Square
            </p>
          </div>

          <div className="pt-4">
            <PrimaryButton onClick={onClose} className="w-full">
              Close
            </PrimaryButton>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

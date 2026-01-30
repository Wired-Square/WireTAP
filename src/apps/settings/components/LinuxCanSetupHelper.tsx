// src/apps/settings/components/LinuxCanSetupHelper.tsx
//
// Shows the setup command required to configure a CAN interface on Linux.
// Provides a copy button for easy use.

import { useState, useEffect } from "react";
import { Copy, Check, Terminal } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { getCanSetupCommand } from "../../../api/gs_usb";
import { alertWarning, helpText } from "../../../styles";

interface Props {
  /** CAN interface name (e.g., "can0") */
  interfaceName: string;
  /** CAN bitrate in bits/second */
  bitrate: number;
}

export default function LinuxCanSetupHelper({ interfaceName, bitrate }: Props) {
  const [setupCommand, setSetupCommand] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (interfaceName && bitrate) {
      getCanSetupCommand(interfaceName, bitrate)
        .then(setSetupCommand)
        .catch(() => setSetupCommand(""));
    } else {
      setSetupCommand("");
    }
  }, [interfaceName, bitrate]);

  const handleCopy = async () => {
    if (!setupCommand) return;

    try {
      await navigator.clipboard.writeText(setupCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = setupCommand;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!setupCommand) {
    return null;
  }

  return (
    <div className={alertWarning}>
      <div className="flex items-start gap-2">
        <Terminal className={`${iconMd} mt-0.5 flex-shrink-0`} />
        <div className="flex-1">
          <p className="text-sm font-medium mb-2">
            Linux setup required
          </p>
          <p className={`${helpText} mb-2`}>
            Run this command in your terminal to configure the CAN interface:
          </p>
          <div className={flexRowGap2}>
            <code className="flex-1 p-2 bg-[var(--bg-warning)] rounded text-xs font-mono break-all">
              {setupCommand}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="p-1.5 hover:bg-[var(--hover-bg-warning)] rounded transition-colors flex-shrink-0"
              title={copied ? "Copied!" : "Copy to clipboard"}
            >
              {copied ? (
                <Check className={`${iconMd} text-[color:var(--accent-success)]`} />
              ) : (
                <Copy className={iconMd} />
              )}
            </button>
          </div>
          <p className={`${helpText} mt-2 text-xs`}>
            Note: You may need to adjust udev rules for non-root access, or run CANdor with elevated privileges.
          </p>
        </div>
      </div>
    </div>
  );
}

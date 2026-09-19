// src/apps/settings/components/LinuxCanSetupHelper.tsx
//
// Shows the setup command required to configure a CAN interface on Linux.
// Provides a copy button for easy use.

import { useState, useEffect } from "react";
import { Copy, Check } from "lucide-react";
import { iconMd, flexRowGap2 } from "../../styles/spacing";
import { getCanSetupCommand } from "../../api/gs_usb";
import { COPY_FEEDBACK_TIMEOUT_MS } from "../../constants";
import { IconButton } from "../Button";
import { Alert } from "../Alert";

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
      setTimeout(() => setCopied(false), COPY_FEEDBACK_TIMEOUT_MS);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = setupCommand;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_TIMEOUT_MS);
    }
  };

  if (!setupCommand) {
    return null;
  }

  return (
    <Alert tone="warning">
      <p className="font-medium mb-2">Linux setup required</p>
      <p className="text-xs mb-2">
        Run this command in your terminal to configure the CAN interface:
      </p>
      <div className={flexRowGap2}>
        <code className="flex-1 p-2 bg-[var(--bg-warning)] rounded text-xs font-mono break-all">
          {setupCommand}
        </code>
        <IconButton
          onClick={handleCopy}
          tone="warning"
          size="sm"
          title={copied ? "Copied!" : "Copy to clipboard"}
        >
          {copied ? (
            <Check className={`${iconMd} text-[color:var(--accent-success)]`} />
          ) : (
            <Copy className={iconMd} />
          )}
        </IconButton>
      </div>
      <p className="text-xs mt-2">
        Note: You may need to adjust udev rules for non-root access, or run WireTAP with elevated privileges.
      </p>
    </Alert>
  );
}

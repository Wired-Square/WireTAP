// src/apps/settings/components/LinuxCanSetupHelper.tsx
//
// Shows the setup command required to configure a CAN interface on Linux.
// Provides a copy button for easy use.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("common");
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
      <p className="font-medium mb-2">{t("linuxCanSetup.title")}</p>
      <p className="text-xs mb-2">{t("linuxCanSetup.instruction")}</p>
      <div className={flexRowGap2}>
        <code className="flex-1 p-2 bg-warning rounded text-xs font-mono break-all">
          {setupCommand}
        </code>
        <IconButton
          onClick={handleCopy}
          tone="warning"
          size="sm"
          title={copied ? t("states.copied") : t("actions.copyToClipboard")}
        >
          {copied ? (
            <Check className={`${iconMd} text-accent-success`} />
          ) : (
            <Copy className={iconMd} />
          )}
        </IconButton>
      </div>
      <p className="text-xs mt-2">{t("linuxCanSetup.note")}</p>
    </Alert>
  );
}

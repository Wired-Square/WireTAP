// src/apps/session-manager/nodes/AppNode.tsx

import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Port } from "./Port";
import { APP_INPUT_PORT } from "../utils/layoutUtils";
import { iconSm } from "../../../styles/spacing";
import { isPanelId } from "../../../apps/registry";
import { AppIcon } from "../../../components/AppIcon";

export interface AppNodeData {
  appId: string;
  appName: string;
  sessionId?: string;
  isActive: boolean;
  isConnected: boolean;
  registeredSecondsAgo?: number;
}

interface AppNodeProps {
  data: AppNodeData;
  selected: boolean;
}

function AppNode({ data, selected }: AppNodeProps) {
  const { t } = useTranslation("sessionManager");
  const { appId, appName, isActive } = data;

  const borderColour = selected
    ? "border-text-cyan"
    : data.isConnected
    ? "border-default"
    : "border-dashed border-default";

  const bgColour = "bg-surface";

  // Show the cosmetic per-instance id (e.g. "decoder_a3f9").
  const displayName = appName === "mcp" ? t("node.app.mcpAgent") : appId;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 ${borderColour} ${bgColour} min-w-30 shadow-lg ${!data.isConnected ? "opacity-40" : isActive ? "" : "opacity-50"}`}
    >
      <Port id={APP_INPUT_PORT} side="left" pinned className="bg-text-green border-success" />

      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <AppIcon app={isPanelId(appName) ? appName : null} className={iconSm} />
        <span className="font-medium text-sm text-primary truncate">
          {displayName}
        </span>
        <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${isActive ? "bg-success-text" : "bg-text-muted"}`} />
      </div>

    </div>
  );
}

export default memo(AppNode);

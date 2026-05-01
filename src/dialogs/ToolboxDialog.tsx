// ui/src/dialogs/ToolboxDialog.tsx

import { X, ListOrdered, GitCompare, Play, Loader2, Radio, Binary, ShieldCheck, Radar, Network } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { iconMd, iconLg } from "../styles/spacing";
import Dialog from "../components/Dialog";
import { useDiscoveryStore, TOOL_TAB_CONFIG, type ToolboxView } from "../stores/discoveryStore";
import {
  cardElevated,
  h3,
  borderDefault,
  paddingCard,
  hoverLight,
  roundedDefault,
  spaceYSmall,
  textTertiary,
} from "../styles";
import MessageOrderToolPanel from "../apps/discovery/views/tools/MessageOrderToolPanel";
import ChangesToolPanel from "../apps/discovery/views/tools/ChangesToolPanel";
import SerialFramingToolPanel from "../apps/discovery/views/tools/SerialFramingToolPanel";
import SerialPayloadToolPanel from "../apps/discovery/views/tools/SerialPayloadToolPanel";
import ChecksumDiscoveryToolPanel from "../apps/discovery/views/tools/ChecksumDiscoveryToolPanel";
import ModbusRegisterScanPanel from "../apps/discovery/views/tools/ModbusRegisterScanPanel";
import ModbusUnitIdScanPanel from "../apps/discovery/views/tools/ModbusUnitIdScanPanel";
import type { ModbusScanConfig, UnitIdScanConfig } from "../api/io";

type ToolConfig = {
  id: ToolboxView;
  /** Translation key suffix under `toolbox.tools.*` */
  i18nKey: string;
  icon: React.ComponentType<{ className?: string }>;
  /** For serial tools: 'bytes' requires raw bytes, 'frames' requires framed data */
  serialRequires?: 'bytes' | 'frames';
  /** For modbus tools: requires a modbus_tcp profile */
  modbusRequires?: boolean;
};

const tools: ToolConfig[] = [
  { id: "message-order", i18nKey: "messageOrder", icon: ListOrdered },
  { id: "changes", i18nKey: "changes", icon: GitCompare },
  { id: "checksum-discovery", i18nKey: "checksumDiscovery", icon: ShieldCheck },
  { id: "serial-framing", i18nKey: "serialFraming", icon: Binary, serialRequires: 'bytes' },
  { id: "serial-payload", i18nKey: "serialPayload", icon: Radio, serialRequires: 'frames' },
  { id: "modbus-register-scan", i18nKey: "modbusRegisterScan", icon: Radar, modbusRequires: true },
  { id: "modbus-unit-scan", i18nKey: "modbusUnitScan", icon: Network, modbusRequires: true },
];

/** Check if a tool is a modbus scan tool (these produce data, not analyse it) */
function isModbusScanTool(id: ToolboxView): boolean {
  return id === 'modbus-register-scan' || id === 'modbus-unit-scan';
}

type Props = {
  isOpen: boolean;
  onClose: () => void;
  selectedCount: number;
  frameCount: number;
  /** True when in serial mode - filters available tools and uses serial frame data */
  isSerialMode?: boolean;
  /** True when the Filtered tab is active — analysis will target filtered-out IDs */
  isFilteredView?: boolean;
  /** Number of serial frames (framedData + frames) available for analysis */
  serialFrameCount?: number;
  /** Number of raw serial bytes available (before framing) */
  serialBytesCount?: number;
  /** True when active profile is modbus_tcp */
  isModbusProfile?: boolean;
  /** Connection details from the active modbus profile */
  modbusConnection?: { host: string; port: number; unit_id: number } | null;
  /** Called when a modbus register scan should start */
  onStartModbusScan?: (config: ModbusScanConfig) => void;
  /** Called when a modbus unit ID scan should start */
  onStartModbusUnitIdScan?: (config: UnitIdScanConfig) => void;
};

function getSelectionText(
  t: TFunction,
  activeTool: ToolboxView | null,
  count: number,
  isSerialMode: boolean,
  isFilteredView: boolean,
): string {
  if (activeTool === "serial-framing") {
    return t("toolbox.selection.bytes", { count });
  }
  if (isSerialMode) {
    return isFilteredView
      ? t("toolbox.selection.framesFilteredAvailable", { count })
      : t("toolbox.selection.framesAvailable", { count });
  }
  return isFilteredView
    ? t("toolbox.selection.framesFilteredSelected", { count })
    : t("toolbox.selection.framesSelected", { count });
}

export default function ToolboxDialog({
  isOpen,
  onClose,
  selectedCount,
  frameCount,
  isSerialMode = false,
  isFilteredView = false,
  serialFrameCount = 0,
  serialBytesCount = 0,
  isModbusProfile = false,
  modbusConnection,
  onStartModbusScan,
  onStartModbusUnitIdScan,
}: Props) {
  const { t } = useTranslation("dialogs");
  const activeView = useDiscoveryStore((s) => s.toolbox.activeView);
  const isRunning = useDiscoveryStore((s) => s.toolbox.isRunning);
  const setActiveView = useDiscoveryStore((s) => s.setActiveView);
  const runAnalysis = useDiscoveryStore((s) => s.runAnalysis);
  const setSerialActiveTab = useDiscoveryStore((s) => s.setSerialActiveTab);

  const activeTool = activeView !== "frames" ? activeView : null;

  // Filter tools based on mode
  const availableTools = isSerialMode
    ? tools.filter((t) => t.serialRequires !== undefined)
    : isModbusProfile
      ? tools.filter((t) => t.modbusRequires === true || (!t.serialRequires && !t.modbusRequires))
      : tools.filter((t) => !t.serialRequires && !t.modbusRequires);

  const isToolAvailable = (tool: ToolConfig): boolean => {
    if (tool.modbusRequires) return isModbusProfile;
    if (!isSerialMode) return frameCount > 0;
    if (tool.serialRequires === 'bytes') return serialBytesCount > 0;
    if (tool.serialRequires === 'frames') return serialFrameCount > 0;
    return false;
  };

  const getEffectiveCount = (): number => {
    if (!activeTool) return 0;
    const tool = tools.find(t => t.id === activeTool);
    if (!tool) return 0;
    if (tool.modbusRequires) return 0;
    if (!isSerialMode) return selectedCount;
    if (tool.serialRequires === 'bytes') return serialBytesCount;
    if (tool.serialRequires === 'frames') return serialFrameCount;
    return 0;
  };

  const effectiveSelectedCount = getEffectiveCount();

  const getDisabledReason = (tool: ToolConfig): string | null => {
    if (tool.modbusRequires) {
      return isModbusProfile ? null : t("toolbox.disabledReasons.modbusProfile");
    }
    if (!isSerialMode) {
      return frameCount === 0 ? t("toolbox.disabledReasons.noFrames") : null;
    }
    if (tool.serialRequires === 'bytes' && serialBytesCount === 0) {
      return t("toolbox.disabledReasons.noBytes");
    }
    if (tool.serialRequires === 'frames' && serialFrameCount === 0) {
      return t("toolbox.disabledReasons.needFraming");
    }
    return null;
  };

  const handleToolClick = (toolId: ToolboxView) => {
    const tool = tools.find(t => t.id === toolId);
    if (!tool || !isToolAvailable(tool)) return;
    if (activeView === toolId) {
      setActiveView("frames");
    } else {
      setActiveView(toolId);
    }
  };

  const handleRunAnalysis = async () => {
    if (effectiveSelectedCount === 0 || isRunning || !activeTool) return;
    await runAnalysis();
    onClose();
    if (activeTool === "serial-framing" || activeTool === "serial-payload") {
      const config = TOOL_TAB_CONFIG[activeTool];
      if (config) {
        setSerialActiveTab(config.tabId);
      }
    }
  };

  const handleStartModbusScan = (config: ModbusScanConfig) => {
    onStartModbusScan?.(config);
    onClose();
  };

  const handleStartModbusUnitIdScan = (config: UnitIdScanConfig) => {
    onStartModbusUnitIdScan?.(config);
    onClose();
  };

  const isActiveModbusScan = activeTool != null && isModbusScanTool(activeTool);

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-lg">
      <div className={`${cardElevated} shadow-xl overflow-hidden flex flex-col`}>
        {/* Header */}
        <div className={`${paddingCard} flex items-center justify-between border-b ${borderDefault}`}>
          <h2 className={h3}>
            {isModbusProfile ? t("toolbox.titleAnalysisAndScanning") : t("toolbox.titleAnalysis")}
          </h2>
          <button
            onClick={onClose}
            className={`p-1 ${roundedDefault} ${hoverLight} transition-colors`}
          >
            <X className={iconLg} />
          </button>
        </div>

        {/* Content */}
        <div className={`${paddingCard} ${spaceYSmall}`}>
          {/* Tool selection */}
          <div className={spaceYSmall}>
            {availableTools.map((tool) => {
              const Icon = tool.icon;
              const isActive = activeTool === tool.id;
              const isDisabled = !isToolAvailable(tool);
              const disabledReason = getDisabledReason(tool);
              const label = t(`toolbox.tools.${tool.i18nKey}.label`);
              const description = t(`toolbox.tools.${tool.i18nKey}.description`);

              return (
                <button
                  key={tool.id}
                  type="button"
                  onClick={() => handleToolClick(tool.id)}
                  disabled={isDisabled}
                  className={`flex items-start gap-3 w-full p-3 rounded-lg text-left transition-all ${
                    isDisabled
                      ? "bg-[var(--bg-surface)] text-[color:var(--text-muted)] cursor-not-allowed"
                      : isActive
                        ? "bg-purple-100 text-[color:var(--text-purple)] ring-2 ring-purple-500"
                        : "bg-[var(--bg-surface)] text-[color:var(--text-secondary)] ring-1 ring-[color:var(--border-default)] hover:ring-2 hover:ring-purple-400"
                  }`}
                  title={disabledReason ?? label}
                >
                  <Icon className={`${iconLg} mt-0.5 flex-shrink-0 ${isActive ? "text-[color:var(--text-purple)]" : ""}`} />
                  <div>
                    <div className="font-medium text-sm">{label}</div>
                    <div className={`text-xs mt-0.5 ${isActive ? "text-[color:var(--text-purple)] opacity-70" : "text-[color:var(--text-muted)]"}`}>
                      {description}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Tool-specific options panel */}
          {activeTool && (
            <div className={`border-t ${borderDefault} pt-3`}>
              {activeTool === "message-order" && <MessageOrderToolPanel />}
              {activeTool === "changes" && <ChangesToolPanel />}
              {activeTool === "checksum-discovery" && <ChecksumDiscoveryToolPanel />}
              {activeTool === "serial-framing" && <SerialFramingToolPanel bytesCount={serialBytesCount} />}
              {activeTool === "serial-payload" && <SerialPayloadToolPanel framesCount={serialFrameCount} />}
              {activeTool === "modbus-register-scan" && modbusConnection && (
                <ModbusRegisterScanPanel
                  connection={modbusConnection}
                  onStartScan={handleStartModbusScan}
                />
              )}
              {activeTool === "modbus-unit-scan" && modbusConnection && (
                <ModbusUnitIdScanPanel
                  connection={modbusConnection}
                  onStartScan={handleStartModbusUnitIdScan}
                />
              )}
            </div>
          )}

          {/* Selection count and run button (for analysis tools, not modbus scan) */}
          {activeTool && !isActiveModbusScan && (
            <div className={`border-t ${borderDefault} pt-3 ${spaceYSmall}`}>
              <div className={`text-sm ${textTertiary}`}>
                {getSelectionText(t, activeTool, effectiveSelectedCount, isSerialMode, isFilteredView)}
              </div>
              <button
                type="button"
                onClick={handleRunAnalysis}
                disabled={effectiveSelectedCount === 0 || isRunning}
                className={`flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  effectiveSelectedCount === 0 || isRunning
                    ? "bg-[var(--bg-surface)] text-[color:var(--text-muted)] cursor-not-allowed"
                    : "bg-purple-600 hover:bg-purple-700 text-white"
                }`}
              >
                {isRunning ? (
                  <Loader2 className={`${iconMd} animate-spin`} />
                ) : (
                  <Play className={iconMd} />
                )}
                {isRunning ? t("toolbox.running") : t("toolbox.runAnalysis")}
              </button>
            </div>
          )}

          {/* Help text when no tool selected */}
          {!activeTool && availableTools.some(t => isToolAvailable(t)) && (
            <div className={`text-xs ${textTertiary} text-center py-2`}>
              {t("toolbox.selectTool")}
            </div>
          )}

          {/* Help text when no data */}
          {!availableTools.some(t => isToolAvailable(t)) && (
            <div className={`text-xs ${textTertiary} text-center py-2`}>
              {isSerialMode ? t("toolbox.noDataSerial") : t("toolbox.noDataDefault")}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

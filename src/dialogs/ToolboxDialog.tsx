// ui/src/dialogs/ToolboxDialog.tsx

import { X, ListOrdered, GitCompare, Play, Loader2, Radio, Binary, ShieldCheck } from "lucide-react";
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

type ToolConfig = {
  id: ToolboxView;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  /** For serial tools: 'bytes' requires raw bytes, 'frames' requires framed data */
  serialRequires?: 'bytes' | 'frames';
};

const tools: ToolConfig[] = [
  {
    id: "message-order",
    label: "Frame Order Analysis",
    description: "Analyze frame timing patterns and message order",
    icon: ListOrdered,
  },
  {
    id: "changes",
    label: "Payload Change Analysis",
    description: "Detect payload variations and potential mux patterns",
    icon: GitCompare,
  },
  {
    id: "checksum-discovery",
    label: "Checksum Discovery",
    description: "Detect checksum algorithms and CRC parameters per frame ID",
    icon: ShieldCheck,
  },
  {
    id: "serial-framing",
    label: "Serial Framing Analysis",
    description: "Detect framing protocol (SLIP, Modbus RTU, delimiters)",
    icon: Binary,
    serialRequires: 'bytes',
  },
  {
    id: "serial-payload",
    label: "Serial Payload Analysis",
    description: "Identify ID bytes and checksum positions in framed data",
    icon: Radio,
    serialRequires: 'frames',
  },
];

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
};

export default function ToolboxDialog({
  isOpen,
  onClose,
  selectedCount,
  frameCount,
  isSerialMode = false,
  isFilteredView = false,
  serialFrameCount = 0,
  serialBytesCount = 0,
}: Props) {
  const activeView = useDiscoveryStore((s) => s.toolbox.activeView);
  const isRunning = useDiscoveryStore((s) => s.toolbox.isRunning);
  const setActiveView = useDiscoveryStore((s) => s.setActiveView);
  const runAnalysis = useDiscoveryStore((s) => s.runAnalysis);
  const setSerialActiveTab = useDiscoveryStore((s) => s.setSerialActiveTab);

  const activeTool = activeView !== "frames" ? activeView : null;

  // In serial mode, show both serial tools
  // In CAN mode, exclude serial tools
  const availableTools = isSerialMode
    ? tools.filter((t) => t.serialRequires !== undefined)
    : tools.filter((t) => t.serialRequires === undefined);

  // Check if a specific tool is available based on its requirements
  const isToolAvailable = (tool: ToolConfig): boolean => {
    if (!isSerialMode) {
      return frameCount > 0;
    }
    // Serial mode: check specific requirements
    if (tool.serialRequires === 'bytes') {
      return serialBytesCount > 0;
    }
    if (tool.serialRequires === 'frames') {
      return serialFrameCount > 0;
    }
    return false;
  };

  // Get the count to show for the active tool
  const getEffectiveCount = (): number => {
    if (!activeTool) return 0;
    const tool = tools.find(t => t.id === activeTool);
    if (!tool) return 0;

    if (!isSerialMode) {
      return selectedCount;
    }
    // Serial mode: show appropriate count
    if (tool.serialRequires === 'bytes') {
      return serialBytesCount;
    }
    if (tool.serialRequires === 'frames') {
      return serialFrameCount;
    }
    return 0;
  };

  const effectiveSelectedCount = getEffectiveCount();

  // Get the disabled reason for a tool
  const getDisabledReason = (tool: ToolConfig): string | null => {
    if (!isSerialMode) {
      return frameCount === 0 ? "No frames discovered" : null;
    }
    if (tool.serialRequires === 'bytes' && serialBytesCount === 0) {
      return "No raw bytes captured";
    }
    if (tool.serialRequires === 'frames' && serialFrameCount === 0) {
      return "Apply framing first to get frames";
    }
    return null;
  };

  const handleToolClick = (toolId: ToolboxView) => {
    const tool = tools.find(t => t.id === toolId);
    if (!tool || !isToolAvailable(tool)) return;
    if (activeView === toolId) {
      // Toggle off - go back to frames view
      setActiveView("frames");
    } else {
      setActiveView(toolId);
    }
  };

  const handleRunAnalysis = async () => {
    if (effectiveSelectedCount === 0 || isRunning || !activeTool) return;
    await runAnalysis();
    // Close dialog - results will appear in tool-specific tabs within Discovery
    onClose();
    // For serial analysis, switch to the tool-specific tab within the Serial Discovery view
    if (activeTool === "serial-framing" || activeTool === "serial-payload") {
      const config = TOOL_TAB_CONFIG[activeTool];
      if (config) {
        setSerialActiveTab(config.tabId);
      }
    }
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-lg">
      <div className={`${cardElevated} shadow-xl overflow-hidden flex flex-col`}>
        {/* Header */}
        <div className={`${paddingCard} flex items-center justify-between border-b ${borderDefault}`}>
          <h2 className={h3}>Analysis Tools</h2>
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
                  title={disabledReason ?? tool.label}
                >
                  <Icon className={`${iconLg} mt-0.5 flex-shrink-0 ${isActive ? "text-[color:var(--text-purple)]" : ""}`} />
                  <div>
                    <div className="font-medium text-sm">{tool.label}</div>
                    <div className={`text-xs mt-0.5 ${isActive ? "text-[color:var(--text-purple)] opacity-70" : "text-[color:var(--text-muted)]"}`}>
                      {tool.description}
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
            </div>
          )}

          {/* Selection count and run button */}
          {activeTool && (
            <div className={`border-t ${borderDefault} pt-3 ${spaceYSmall}`}>
              <div className={`text-sm ${textTertiary}`}>
                {activeTool === "serial-framing"
                  ? `${effectiveSelectedCount.toLocaleString()} byte${effectiveSelectedCount !== 1 ? "s" : ""} available for analysis`
                  : `${effectiveSelectedCount.toLocaleString()} ${isFilteredView ? "filtered" : ""} frame${effectiveSelectedCount !== 1 ? "s" : ""} ${isSerialMode ? "available" : "selected"} for analysis`}
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
                {isRunning ? "Running..." : "Run Analysis"}
              </button>
            </div>
          )}

          {/* Help text when no tool selected */}
          {!activeTool && availableTools.some(t => isToolAvailable(t)) && (
            <div className={`text-xs ${textTertiary} text-center py-2`}>
              Select a tool above to configure and run analysis
            </div>
          )}

          {/* Help text when no data */}
          {!availableTools.some(t => isToolAvailable(t)) && (
            <div className={`text-xs ${textTertiary} text-center py-2`}>
              {isSerialMode
                ? "Import serial data to enable analysis tools"
                : "Start streaming to discover frames for analysis"}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

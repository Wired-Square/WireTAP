// ui/src/components/MainLayout.tsx

import { useRef, useState, useCallback, useEffect, lazy, Suspense } from "react";
import {
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelProps,
  IDockviewHeaderActionsProps,
  IWatermarkPanelProps,
  DockviewApi,
  SerializedDockview,
} from "dockview-react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { storeGet, storeSet } from "../api/store";
import { Settings as SettingsIcon, Search, Activity, FileText, Calculator, Send } from "lucide-react";
import { icon2xl } from "../styles/spacing";
import { bgPrimary, textPrimary, textSecondary, textTertiary } from "../styles/colourTokens";
import "dockview-react/dist/styles/dockview.css";
import LogoMenu, { type PanelId } from "./LogoMenu";
import AppTab from "./AppTab";
import {
  registerOpenPanelFn,
  unregisterOpenPanelFn,
  openPanel,
} from "../utils/windowCommunication";
import {
  getOpenMainWindows,
  addOpenMainWindow,
  removeOpenMainWindow,
  getNextMainWindowNumber,
} from "../utils/persistence";
import { getAppVersion } from "../api";
import logo from "../assets/logo.png";

// Lazy load app components for better initial load
const Discovery = lazy(() => import("../apps/discovery/Discovery"));
const Decoder = lazy(() => import("../apps/decoder/Decoder"));
const Transmit = lazy(() => import("../apps/transmit/Transmit"));
const CatalogEditor = lazy(() => import("../apps/catalog/CatalogEditor"));
const FrameCalculator = lazy(() => import("../apps/calculator/FrameCalculator"));
const PayloadAnalysis = lazy(() => import("../apps/analysis/PayloadAnalysis"));
const FrameOrderAnalysis = lazy(() => import("../apps/analysis/FrameOrderAnalysis"));
const Settings = lazy(() => import("../apps/settings/Settings"));

// Get layout key for a specific window (per-window persistence)
function getLayoutKey(windowLabel: string): string {
  return `layout.${windowLabel}`;
}

const SAVE_DEBOUNCE_MS = 500;

// Panel loading fallback
function PanelLoading() {
  return (
    <div className={`flex items-center justify-center h-full ${bgPrimary}`}>
      <div className="flex flex-col items-center gap-3">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <span className={`text-sm ${textTertiary}`}>Loading...</span>
      </div>
    </div>
  );
}

// Panel wrapper to ensure proper height constraints within Dockview panels
// Panels use h-full (not h-screen) since they're inside the Dockview container
function PanelWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-hidden">
      <Suspense fallback={<PanelLoading />}>
        {children}
      </Suspense>
    </div>
  );
}

// Panel wrapper components for Dockview
function DiscoveryPanel(_props: IDockviewPanelProps) {
  return <PanelWrapper><Discovery /></PanelWrapper>;
}

function DecoderPanel(_props: IDockviewPanelProps) {
  return <PanelWrapper><Decoder /></PanelWrapper>;
}

function TransmitPanel(_props: IDockviewPanelProps) {
  return <PanelWrapper><Transmit /></PanelWrapper>;
}

function CatalogEditorPanel(_props: IDockviewPanelProps) {
  return <PanelWrapper><CatalogEditor /></PanelWrapper>;
}

function FrameCalculatorPanel(_props: IDockviewPanelProps) {
  return <PanelWrapper><FrameCalculator /></PanelWrapper>;
}

function PayloadAnalysisPanel(_props: IDockviewPanelProps) {
  return <PanelWrapper><PayloadAnalysis /></PanelWrapper>;
}

function FrameOrderAnalysisPanel(_props: IDockviewPanelProps) {
  return <PanelWrapper><FrameOrderAnalysis /></PanelWrapper>;
}

function SettingsPanel(_props: IDockviewPanelProps) {
  return <PanelWrapper><Settings /></PanelWrapper>;
}

// Component registry for Dockview
const components = {
  discovery: DiscoveryPanel,
  decoder: DecoderPanel,
  transmit: TransmitPanel,
  "catalog-editor": CatalogEditorPanel,
  "frame-calculator": FrameCalculatorPanel,
  "payload-analysis": PayloadAnalysisPanel,
  "frame-order-analysis": FrameOrderAnalysisPanel,
  settings: SettingsPanel,
};

// Watermark component shown when no panels are open
function Watermark(_props: IWatermarkPanelProps) {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    getAppVersion()
      .then((v) => setVersion(v))
      .catch(() => setVersion(""));
  }, []);

  return (
    <div className={`flex flex-col items-center justify-center h-full ${bgPrimary}`}>
      <div className="flex flex-col items-center gap-6">
        {/* Logo - twice as big */}
        <div className="w-32 h-32 rounded-3xl bg-white shadow-lg flex items-center justify-center">
          <img src={logo} alt="CANdor" className="w-24 h-24 rounded-2xl object-cover" />
        </div>

        {/* Title with version */}
        <div className="relative flex items-baseline justify-center">
          <h1 className={`text-5xl font-semibold ${textPrimary} font-ubuntu`}>
            CANdor
          </h1>
          {version && (
            <span className={`absolute left-full ml-3 text-sm ${textTertiary} font-ubuntu whitespace-nowrap`}>
              v{version}
            </span>
          )}
        </div>

        {/* Byline - closer to title */}
        <p className={`text-lg ${textSecondary} font-ubuntu -mt-4`}>
          by Wired Square
        </p>

        {/* App launcher buttons */}
        <div className="flex gap-4 mt-8">
          <WatermarkAppButton
            icon={Search}
            label="Discovery"
            color="text-purple-400"
            bgColor="bg-purple-500/10 hover:bg-purple-500/20"
            onClick={() => openPanel("discovery")}
          />
          <WatermarkAppButton
            icon={Activity}
            label="Decoder"
            color="text-green-400"
            bgColor="bg-green-500/10 hover:bg-green-500/20"
            onClick={() => openPanel("decoder")}
          />
          <WatermarkAppButton
            icon={Send}
            label="Transmit"
            color="text-red-400"
            bgColor="bg-red-500/10 hover:bg-red-500/20"
            onClick={() => openPanel("transmit")}
          />
          <WatermarkAppButton
            icon={FileText}
            label="Catalog"
            color="text-blue-400"
            bgColor="bg-blue-500/10 hover:bg-blue-500/20"
            onClick={() => openPanel("catalog-editor")}
          />
          <WatermarkAppButton
            icon={Calculator}
            label="Calculator"
            color="text-teal-400"
            bgColor="bg-teal-500/10 hover:bg-teal-500/20"
            onClick={() => openPanel("frame-calculator")}
          />
          <WatermarkAppButton
            icon={SettingsIcon}
            label="Settings"
            color="text-orange-400"
            bgColor="bg-orange-500/10 hover:bg-orange-500/20"
            onClick={() => openPanel("settings")}
          />
        </div>
      </div>
    </div>
  );
}

// Button component for watermark app launcher
interface WatermarkAppButtonProps {
  icon: typeof Search;
  label: string;
  color: string;
  bgColor: string;
  onClick: () => void;
}

function WatermarkAppButton({ icon: Icon, label, color, bgColor, onClick }: WatermarkAppButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-2 p-4 rounded-xl ${bgColor} transition-colors`}
    >
      <Icon className={`${icon2xl} ${color}`} />
      <span className={`text-sm ${textSecondary} font-ubuntu`}>{label}</span>
    </button>
  );
}

// Panel titles for display
const panelTitles: Record<PanelId, string> = {
  discovery: "Discovery",
  decoder: "Decoder",
  transmit: "Transmit",
  "catalog-editor": "Catalog Editor",
  "frame-calculator": "Calculator",
  "payload-analysis": "Payload Analysis",
  "frame-order-analysis": "Frame Order",
  settings: "Settings",
};

export default function MainLayout() {
  const apiRef = useRef<DockviewApi | null>(null);
  const saveTimeoutRef = useRef<number | null>(null);
  const [savedLayout, setSavedLayout] = useState<SerializedDockview | null>(null);
  const [layoutLoaded, setLayoutLoaded] = useState(false);

  // Get window label once (doesn't change during component lifetime)
  const windowLabel = getCurrentWebviewWindow().label;
  const isDynamicWindow = windowLabel.startsWith("main-");
  const layoutKey = getLayoutKey(windowLabel);

  // Load saved layout on mount
  useEffect(() => {
    async function loadLayout() {
      try {
        // Use centralised store API (no file locking issues with multi-window)
        const layout = await storeGet<SerializedDockview>(layoutKey);
        if (layout) {
          setSavedLayout(layout);
        }
      } catch (error) {
        console.error("Failed to load layout:", error);
      }
      setLayoutLoaded(true);
    }
    loadLayout();
  }, [layoutKey]);

  // Register this window in the open windows list
  useEffect(() => {
    // Add this window to the open windows list
    addOpenMainWindow(windowLabel).catch(console.error);

    // On window close, remove from the list
    const currentWindow = getCurrentWebviewWindow();
    const unlisten = currentWindow.onCloseRequested(async () => {
      await removeOpenMainWindow(windowLabel);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [windowLabel]);

  // Dashboard window: restore other windows that were open in previous session
  useEffect(() => {
    if (windowLabel !== "dashboard") return;

    async function restoreWindows() {
      try {
        const savedWindows = await getOpenMainWindows();
        for (const label of savedWindows) {
          // Skip dashboard (already open) and check if window doesn't exist yet
          if (label === "dashboard") continue;
          // Create the window via Rust backend
          await invoke("create_main_window", { label });
        }
      } catch (error) {
        console.error("Failed to restore windows:", error);
      }
    }
    restoreWindows();
  }, [windowLabel]);

  // Listen for "New Window" menu command
  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen("menu-new-window", async () => {
        try {
          // Get the next available window number
          const num = await getNextMainWindowNumber();
          const label = `main-${num}`;
          // Create the window via Rust backend
          await invoke("create_main_window", { label });
        } catch (error) {
          console.error("Failed to create new window:", error);
        }
      });
      return unlisten;
    };

    const unlistenPromise = setupListener();
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  // Save layout with debouncing (per-window persistence)
  const saveLayout = useCallback(() => {
    if (!apiRef.current) return;

    // Clear any pending save
    if (saveTimeoutRef.current) {
      window.clearTimeout(saveTimeoutRef.current);
    }

    // Debounce the save
    saveTimeoutRef.current = window.setTimeout(async () => {
      try {
        const layout = apiRef.current?.toJSON();
        if (layout) {
          // Use centralised store API (no file locking issues with multi-window)
          await storeSet(layoutKey, layout);
        }
      } catch (error) {
        console.error("Failed to save layout:", error);
      }
    }, SAVE_DEBOUNCE_MS);
  }, [layoutKey]);

  // Handle Dockview ready
  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      // Listen for panel and layout changes to trigger save
      event.api.onDidAddPanel(() => {
        saveLayout();
      });
      event.api.onDidRemovePanel(() => {
        saveLayout();
      });
      event.api.onDidLayoutChange(() => {
        saveLayout();
      });

      // Try to restore saved layout
      if (savedLayout) {
        try {
          event.api.fromJSON(savedLayout);
          return;
        } catch (error) {
          console.error("Failed to restore layout, using default:", error);
        }
      }

      // Dynamic windows show the watermark instead of default panel
      if (isDynamicWindow) {
        return;
      }

      // No saved layout or restore failed - open Discovery panel by default
      event.api.addPanel({
        id: "discovery",
        component: "discovery",
        title: panelTitles.discovery,
      });
    },
    [saveLayout, savedLayout, isDynamicWindow]
  );

  // Handle panel open/focus - used by logo menu and cross-panel communication
  const handlePanelClick = useCallback((panelId: string) => {
    if (!apiRef.current) return;

    const existingPanel = apiRef.current.getPanel(panelId);

    if (existingPanel) {
      // Panel exists - focus it
      existingPanel.focus();
    } else {
      // Panel doesn't exist - create it
      apiRef.current.addPanel({
        id: panelId,
        component: panelId,
        title: panelTitles[panelId as PanelId] || panelId,
      });
    }
  }, []);

  // Register panel open function for cross-panel communication
  useEffect(() => {
    registerOpenPanelFn(handlePanelClick);
    return () => {
      unregisterOpenPanelFn();
    };
  }, [handlePanelClick]);

  // Keyboard shortcut for settings (Cmd/Ctrl + , to open settings panel)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        handlePanelClick("settings");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handlePanelClick]);

  // Cleanup save timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        window.clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // Prefix header action: Logo menu (appears before tabs, only in first group)
  const PrefixHeaderActions = useCallback(
    (props: IDockviewHeaderActionsProps) => {
      // Only show logo in the first group to avoid duplicates
      const allGroups = props.containerApi.groups;
      const isFirstGroup = allGroups.length === 0 || allGroups[0].id === props.group.id;

      if (!isFirstGroup) {
        return null;
      }

      return (
        <LogoMenu onPanelClick={handlePanelClick} />
      );
    },
    [handlePanelClick]
  );

  // Don't render Dockview until we've tried to load the layout
  if (!layoutLoaded) {
    return (
      <div className={`h-screen flex items-center justify-center ${bgPrimary}`}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className={`text-sm ${textTertiary}`}>Loading layout...</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-screen flex flex-col ${bgPrimary}`}>
      {/* Dockview container fills the screen */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <DockviewReact
          className="dockview-theme-abyss"
          onReady={onReady}
          components={components}
          defaultTabComponent={AppTab}
          watermarkComponent={Watermark}
          prefixHeaderActionsComponent={PrefixHeaderActions}
        />
      </div>
    </div>
  );
}

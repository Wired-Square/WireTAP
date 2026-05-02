// ui/src/components/MainLayout.tsx

import React, { useRef, useState, useCallback, useEffect, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
import { icon2xl } from "../styles/spacing";
import { bgPrimary, textPrimary, textSecondary, textTertiary } from "../styles/colourTokens";
import { launcherButton, launcherButtonLabel, launcherGrid } from "../styles/buttonStyles";
import "dockview-react/dist/styles/dockview.css";
import LogoMenu from "./LogoMenu";
import AppTab from "./AppTab";
import {
  registerOpenPanelFn,
  unregisterOpenPanelFn,
  openPanel,
} from "../utils/windowCommunication";
import { useWindowPersistence } from "../hooks/useWindowPersistence";
import {
  getOpenMainWindows,
  addOpenMainWindow,
  removeOpenMainWindow,
  getNextMainWindowNumber,
} from "../utils/persistence";
import { getAppVersion, settingsPanelClosed, openSettingsPanel, updateMenuState } from "../api";
import { useSettingsStore } from "../apps/settings/stores/settingsStore";
import { useFocusStore } from "../stores/focusStore";
import { apps, menuApps, menuGroupOrder, type AppEntry, type PanelId } from "../apps/registry";
import type { LucideIcon } from "lucide-react";
const logo = "/logo.svg";

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

// Error boundary so a single panel crash cannot take down the Dockview layout
class PanelErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[PanelErrorBoundary]", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className={`flex items-center justify-center h-full ${bgPrimary}`}>
          <div className="flex flex-col items-center gap-3 p-6 max-w-md text-center">
            <span className={`text-sm font-medium ${textPrimary}`}>Panel Error</span>
            <span className={`text-xs ${textTertiary} break-all`}>{this.state.error.message}</span>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-2 px-3 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Panel wrapper to ensure proper height constraints within Dockview panels
// Panels use h-full (not h-screen) since they're inside the Dockview container
function PanelWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-hidden">
      <PanelErrorBoundary>
        <Suspense fallback={<PanelLoading />}>
          {children}
        </Suspense>
      </PanelErrorBoundary>
    </div>
  );
}

// Build a Dockview panel component from a registry entry's lazy loader.
function makePanelComponent(load: AppEntry["load"]) {
  const LazyComponent = lazy(load);
  return function Panel(_props: IDockviewPanelProps) {
    return (
      <PanelWrapper>
        <LazyComponent />
      </PanelWrapper>
    );
  };
}

// Dockview component registry — derived from the single app registry.
const components = Object.fromEntries(
  apps.map((a) => [a.id, makePanelComponent(a.load)]),
) as Record<PanelId, ReturnType<typeof makePanelComponent>>;

// Watermark component shown when no panels are open
function Watermark(_props: IWatermarkPanelProps) {
  const { t } = useTranslation("menus");
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
          <img src={logo} alt="WireTAP" className="w-24 h-24 rounded-2xl object-cover" />
        </div>

        {/* Title with version */}
        <div className="relative flex items-baseline justify-center">
          <h1 className={`text-5xl font-semibold ${textPrimary} font-ubuntu`}>
            WireTAP
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

        {/* App launcher — grouped by registry group, dividers between groups.
            Outer flex-wrap lets groups stack on narrow viewports. */}
        <div className="flex flex-wrap items-center justify-center gap-3 mt-8 px-4">
          {menuGroupOrder
            .map((group) => ({
              group,
              items: menuApps.filter((a) => a.group === group),
            }))
            .filter((g) => g.items.length > 0)
            .map((g, groupIndex) => (
              <div key={g.group} className="flex items-center gap-3">
                {groupIndex > 0 && (
                  <div
                    aria-hidden
                    className="self-stretch w-px bg-[color:var(--border-default)] opacity-50"
                  />
                )}
                <div className={launcherGrid}>
                  {g.items.map((app) => (
                    <WatermarkAppButton
                      key={app.id}
                      icon={app.icon}
                      label={t(`panels.${app.i18nKey}`)}
                      color={app.colour}
                      bgColor={app.watermarkBg}
                      onClick={() => {
                        if (app.singleton) {
                          openSettingsPanel();
                        } else {
                          openPanel(app.id);
                        }
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

// Button component for watermark app launcher
interface WatermarkAppButtonProps {
  icon: LucideIcon;
  label: string;
  color: string;
  bgColor: string;
  onClick: () => void;
}

function WatermarkAppButton({ icon: Icon, label, color, bgColor, onClick }: WatermarkAppButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`${launcherButton} ${bgColor}`}
    >
      <Icon className={`${icon2xl} ${color}`} />
      <span className={launcherButtonLabel}>{label}</span>
    </button>
  );
}

// Panel ID → menus.json key — derived from the registry.
const panelI18nKeys = Object.fromEntries(
  apps.map((a) => [a.id, a.i18nKey]),
) as Record<PanelId, string>;

function getPanelTitle(t: TFunction, panelId: PanelId): string {
  const key = panelI18nKeys[panelId];
  return key ? t(`panels.${key}`) : panelId;
}

export default function MainLayout() {
  const { t } = useTranslation("menus");
  const apiRef = useRef<DockviewApi | null>(null);
  const saveTimeoutRef = useRef<number | null>(null);
  const [savedLayout, setSavedLayout] = useState<SerializedDockview | null>(null);
  const [layoutLoaded, setLayoutLoaded] = useState(false);


  // Get window label once (doesn't change during component lifetime)
  const windowLabel = getCurrentWebviewWindow().label;
  const isDynamicWindow = windowLabel.startsWith("main-");
  const layoutKey = getLayoutKey(windowLabel);

  // Persist and restore window geometry (size + position) across restarts
  useWindowPersistence(windowLabel);

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

      // Listen for panel and layout changes to trigger save + track open panels
      event.api.onDidAddPanel((panel) => {
        useFocusStore.getState().addOpenPanel(panel.id);
        saveLayout();
      });
      event.api.onDidRemovePanel((panel) => {
        useFocusStore.getState().removeOpenPanel(panel.id);
        // Notify backend when Settings panel is closed (singleton tracking)
        if (panel.id === "settings") {
          settingsPanelClosed();
        }
        saveLayout();
      });
      event.api.onDidLayoutChange(() => {
        saveLayout();
      });

      // Track focused panel in store (used for session-control targeting)
      event.api.onDidActivePanelChange((panel) => {
        useFocusStore.getState().setFocusedPanelId(panel?.id ?? null);
      });

      // Try to restore saved layout
      if (savedLayout) {
        try {
          event.api.fromJSON(savedLayout);
        } catch (error) {
          console.error("Failed to restore layout, using default:", error);
        }
      }

      // Dynamic windows show the watermark instead of default panel
      if (!savedLayout && isDynamicWindow) {
        return;
      }

      // No saved layout or restore failed - open Discovery panel by default
      if (!savedLayout) {
        event.api.addPanel({
          id: "discovery",
          component: "discovery",
          title: getPanelTitle(t, "discovery"),
        });
      }

      // Seed the open panels store from all currently loaded panels
      useFocusStore.getState().setOpenPanels(event.api.panels.map((p) => p.id));

      // Set initial active panel in store
      useFocusStore.getState().setFocusedPanelId(event.api.activePanel?.id ?? null);
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
        title: getPanelTitle(t, panelId as PanelId),
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
  // Note: This is a fallback - the native menu accelerator handles this too
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        openSettingsPanel(); // Uses singleton behavior via backend
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Listen for menu commands to open/focus panels
  useEffect(() => {
    const currentWindow = getCurrentWebviewWindow();

    const setupListeners = async () => {
      // Open panel (creates if doesn't exist, focuses if exists)
      const unlistenOpen = await currentWindow.listen<string>(
        "menu-open-panel",
        (event) => {
          handlePanelClick(event.payload);
        }
      );

      // Focus panel (only focuses if exists)
      const unlistenFocus = await currentWindow.listen<string>(
        "menu-focus-panel",
        (event) => {
          apiRef.current?.getPanel(event.payload)?.focus();
        }
      );

      return () => {
        unlistenOpen();
        unlistenFocus();
      };
    };

    const cleanup = setupListeners();
    return () => {
      cleanup.then((fn) => fn());
    };
  }, [handlePanelClick]);

  // Disable all session + bookmark menu items when a non-session panel is focused.
  // Session-aware panels manage their own state via useMenuSessionControl.
  const SESSION_AWARE_PANELS = useRef(new Set(["discovery", "decoder", "transmit", "modbus", "query", "graph"]));
  const focusedPanelId = useFocusStore((s) => s.focusedPanelId);

  useEffect(() => {
    const hasSession = focusedPanelId !== null && SESSION_AWARE_PANELS.current.has(focusedPanelId);
    if (!hasSession) {
      updateMenuState({
        hasSession: false,
        profileName: null,
        isStreaming: false,
        isPaused: false,
        canPause: false,
        joinerCount: 0,
        hasBookmarks: false,
      });
    }
  }, [focusedPanelId]);

  // Navigate to Bookmarks tab in Settings (not a session-control event)
  useEffect(() => {
    const currentWindow = getCurrentWebviewWindow();
    const setupListeners = async () => {
      const unlistenBookmarkManage = await currentWindow.listen("menu-bookmark-manage", () => {
        useSettingsStore.getState().setSection("bookmarks");
      });
      return () => {
        unlistenBookmarkManage();
      };
    };
    const cleanup = setupListeners();
    return () => {
      cleanup.then((fn) => fn());
    };
  }, []);

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
    <div
      className={`h-full flex flex-col ${bgPrimary}`}
      style={{
        paddingBottom: 'var(--safe-area-inset-bottom, 0px)',
      }}
    >
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

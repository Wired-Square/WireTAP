// ui/src/components/LogoMenu.tsx

import { useState, useRef, useEffect } from "react";
import { Search, Activity, FileText, Calculator, Settings, Send, ArrowUpCircle, DatabaseZap, Network, BarChart3 } from "lucide-react";
import { iconMd } from "../styles/spacing";
import { bgSurface, borderDefault, textPrimary } from "../styles";
import { openUrl } from "@tauri-apps/plugin-opener";
const logo = "/logo.png";
import { useUpdateStore } from "../stores/updateStore";
import { openSettingsPanel } from "../api";

export type PanelId = "discovery" | "decoder" | "catalog-editor" | "frame-calculator" | "payload-analysis" | "frame-order-analysis" | "transmit" | "query" | "session-manager" | "graph" | "settings";

interface LogoMenuProps {
  onPanelClick: (panelId: PanelId) => void;
}

interface MenuItem {
  id: PanelId;
  icon: typeof Search;
  label: string;
  color: string;
  bgColor: string;
}

// Order and grouping matches the native Apps menu:
// Session-aware apps (1-5), then tools (6-8), then Settings
const menuItems: MenuItem[] = [
  {
    id: "discovery",
    icon: Search,
    label: "Discovery",
    color: "text-purple-400",
    bgColor: "hover:bg-purple-500/10",
  },
  {
    id: "decoder",
    icon: Activity,
    label: "Decoder",
    color: "text-green-400",
    bgColor: "hover:bg-green-500/10",
  },
  {
    id: "transmit",
    icon: Send,
    label: "Transmit",
    color: "text-red-400",
    bgColor: "hover:bg-red-500/10",
  },
  {
    id: "query",
    icon: DatabaseZap,
    label: "Query",
    color: "text-amber-400",
    bgColor: "hover:bg-amber-500/10",
  },
  {
    id: "graph",
    icon: BarChart3,
    label: "Graph",
    color: "text-pink-400",
    bgColor: "hover:bg-pink-500/10",
  },
  {
    id: "catalog-editor",
    icon: FileText,
    label: "Catalog Editor",
    color: "text-blue-400",
    bgColor: "hover:bg-blue-500/10",
  },
  {
    id: "frame-calculator",
    icon: Calculator,
    label: "Calculator",
    color: "text-teal-400",
    bgColor: "hover:bg-teal-500/10",
  },
  {
    id: "session-manager",
    icon: Network,
    label: "Sessions",
    color: "text-cyan-400",
    bgColor: "hover:bg-cyan-500/10",
  },
  {
    id: "settings",
    icon: Settings,
    label: "Settings",
    color: "text-orange-400",
    bgColor: "hover:bg-orange-500/10",
  },
];

export default function LogoMenu({ onPanelClick }: LogoMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const availableUpdate = useUpdateStore((s) => s.availableUpdate);

  const handleUpdateClick = () => {
    if (availableUpdate) {
      openUrl(availableUpdate.url);
    }
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  // Close menu on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [isOpen]);

  const handleItemClick = (panelId: PanelId) => {
    if (panelId === "settings") {
      // Settings uses singleton behavior via backend
      openSettingsPanel();
    } else {
      onPanelClick(panelId);
    }
    setIsOpen(false);
  };

  return (
    <div ref={menuRef} className="relative flex items-center px-2 gap-2" style={{ height: '35px' }}>
      {/* Logo button with white rounded background */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-center hover:shadow transition-all"
        title="Open app menu"
      >
        <img
          src={logo}
          alt="WireTAP"
          className="w-full h-full object-contain"
        />
      </button>

      {/* Update available indicator */}
      {availableUpdate && (
        <button
          onClick={handleUpdateClick}
          className="flex items-center gap-1 transition-colors"
          style={{ backgroundColor: '#2563eb', color: 'white', padding: '4px 8px', borderRadius: '6px', fontSize: '12px', fontWeight: 500 }}
          title={`Update available: ${availableUpdate.version}`}
        >
          <ArrowUpCircle className={iconMd} />
          <span>Update</span>
        </button>
      )}

      {/* Dropdown menu */}
      {isOpen && (
        <div className={`absolute top-full left-2 mt-1 py-1 min-w-[180px] ${bgSurface} ${borderDefault} ${textPrimary} rounded-lg shadow-xl z-50`}>
          {menuItems.map((item) => {
            const Icon = item.icon;
            const showDivider = item.id === "catalog-editor" || item.id === "settings";
            return (
              <div key={item.id}>
                {showDivider && <div className={`my-1 border-t ${borderDefault}`} />}
                <button
                  onClick={() => handleItemClick(item.id)}
                  className={`
                    w-full flex items-center gap-3 px-3 py-2 text-left
                    ${textPrimary} font-medium
                    ${item.bgColor} transition-colors
                  `}
                >
                  <Icon className={`${iconMd} ${item.color}`} />
                  <span className="text-sm">{item.label}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

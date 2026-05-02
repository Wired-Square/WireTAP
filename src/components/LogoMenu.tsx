// ui/src/components/LogoMenu.tsx

import { useState, useRef, useEffect } from "react";
import { ArrowUpCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconMd, marginAppContent } from "../styles/spacing";
import { bgSurface, borderDefault, textPrimary } from "../styles";
import { openUrl } from "@tauri-apps/plugin-opener";
const logo = "/logo.svg";
import { useUpdateStore } from "../stores/updateStore";
import { openSettingsPanel } from "../api";
import { menuApps, menuGroupOrder, type PanelId } from "../apps/registry";

export type { PanelId };

interface LogoMenuProps {
  onPanelClick: (panelId: PanelId) => void;
}

// Items grouped by `menuGroupOrder`, preserving the registry's declared order
// within each group. Empty groups are skipped so dividers don't double up.
const menuGroups = menuGroupOrder
  .map((group) => ({
    group,
    items: menuApps.filter((a) => a.group === group),
  }))
  .filter((g) => g.items.length > 0);

export default function LogoMenu({ onPanelClick }: LogoMenuProps) {
  const { t } = useTranslation("menus");
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
    const app = menuApps.find((a) => a.id === panelId);
    if (app?.singleton) {
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
        title={t("logo.tooltip")}
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
          title={t("logo.updateAvailable", { version: availableUpdate.version })}
        >
          <ArrowUpCircle className={iconMd} />
          <span>{t("logo.updateLabel")}</span>
        </button>
      )}

      {/* Dropdown menu */}
      {isOpen && (
        <div className={`absolute top-full left-2 mt-1 min-w-[180px] ${bgSurface} ${borderDefault} ${textPrimary} rounded-lg shadow-xl z-50`}>
          {menuGroups.map((g, groupIndex) => (
            <div key={g.group}>
              {groupIndex > 0 && (
                <div className={`my-2 mx-2 border-t ${borderDefault}`} />
              )}
              {g.items.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.id} className={marginAppContent}>
                    <button
                      onClick={() => handleItemClick(item.id)}
                      className={`
                        w-full flex items-center px-3 py-2 text-left rounded
                        ${textPrimary} font-medium
                        ${item.bgColour} transition-colors
                      `}
                    >
                      <Icon className={`${iconMd} ${item.colour} shrink-0`} />
                      <span className="text-sm ml-2">{t(`panels.${item.i18nKey}`)}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

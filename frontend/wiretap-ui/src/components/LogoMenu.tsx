// ui/src/components/LogoMenu.tsx

import { ArrowUpCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconMd } from "../styles/spacing";
import { openUrl } from "@tauri-apps/plugin-opener";
const logo = "/logo.svg";
import { useUpdateStore } from "../stores/updateStore";
import { openSettingsPanel } from "../api";
import { menuApps, menuGroupOrder, type PanelId } from "../apps/registry";
import { Button } from "./Button";
import { Menu, MenuItem, MenuSeparator, usePopover } from "./Menu";

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
  const menu = usePopover();
  const availableUpdate = useUpdateStore((s) => s.availableUpdate);

  const handleUpdateClick = () => {
    if (availableUpdate) {
      openUrl(availableUpdate.url);
    }
  };

  const handleItemClick = (panelId: PanelId) => {
    const app = menuApps.find((a) => a.id === panelId);
    if (app?.singleton) {
      openSettingsPanel();
    } else {
      onPanelClick(panelId);
    }
  };

  return (
    <div className="flex items-center px-2 gap-2" style={{ height: '35px' }}>
      {/* Logo button with white rounded background */}
      <Button {...menu.trigger} variant="link" title={t("logo.tooltip")}>
        <img
          src={logo}
          alt="WireTAP"
          className="w-full h-full object-contain"
        />
      </Button>

      {/* Update available indicator */}
      {availableUpdate && (
        <Button
          onClick={handleUpdateClick}
          variant="solid"
          tone="primary"
          size="sm"
          title={t("logo.updateAvailable", { version: availableUpdate.version })}
        >
          <ArrowUpCircle className={iconMd} />
          <span>{t("logo.updateLabel")}</span>
        </Button>
      )}

      <Menu {...menu.popover} size="lg" className="min-w-[180px]">
        {menuGroups.map((g, groupIndex) => (
          <div key={g.group}>
            {groupIndex > 0 && <MenuSeparator />}
            {g.items.map((item) => {
              const Icon = item.icon;
              return (
                <MenuItem
                  key={item.id}
                  onClick={() => handleItemClick(item.id)}
                  icon={<Icon className={item.colour} />}
                  className={`font-medium ${item.bgColour}`}
                >
                  {t(`panels.${item.i18nKey}`)}
                </MenuItem>
              );
            })}
          </div>
        ))}
      </Menu>
    </div>
  );
}

// ui/src/components/ContextMenu.tsx
//
// A menu at the pointer from a list of items — the right-click menus on the
// frame tables and the terminal.

import type { ReactNode } from "react";
import { Menu, MenuItem, MenuSeparator } from "./Menu";

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  /** Renders a horizontal divider instead of a button (label/onClick ignored) */
  separator?: boolean;
}

interface ContextMenuProps {
  /** Menu items to display */
  items: ContextMenuItem[];
  /** Position in viewport (clientX/clientY from MouseEvent) */
  position: { x: number; y: number };
  /** Called when menu should close (outside click, Escape, or item click) */
  onClose: () => void;
}

export default function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  return (
    <Menu open at={position} onClose={onClose}>
      {items.map((item, idx) =>
        item.separator ? (
          <MenuSeparator key={idx} />
        ) : (
          <MenuItem key={idx} icon={item.icon} onClick={item.onClick}>
            {item.label}
          </MenuItem>
        ),
      )}
    </Menu>
  );
}

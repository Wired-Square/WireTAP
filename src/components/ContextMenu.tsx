// ui/src/components/ContextMenu.tsx
//
// Reusable context menu component.
// Renders a positioned dropdown at mouse coordinates with item actions.

import { useEffect, useRef, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { bgSurface, borderDefault, textPrimary } from '../styles';
import { iconXs } from '../styles/spacing';

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  /** When defined, renders a checkmark toggle indicator */
  checked?: boolean;
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
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className={`fixed py-1 min-w-[160px] ${bgSurface} border ${borderDefault} ${textPrimary} rounded-lg shadow-xl z-50`}
      style={{ left: position.x, top: position.y }}
    >
      {items.map((item, idx) => {
        if (item.separator) {
          return <div key={idx} className={`my-1 border-t ${borderDefault}`} />;
        }
        const hasCheckIndicator = item.checked !== undefined;
        return (
          <button
            key={idx}
            onClick={() => { item.onClick(); onClose(); }}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${textPrimary} hover:bg-[var(--hover-bg)] transition-colors`}
          >
            {hasCheckIndicator ? (
              item.checked
                ? <Check className={iconXs} />
                : <span className={`${iconXs} inline-block`} />
            ) : item.icon}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

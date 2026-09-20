// ui/src/components/OverflowMenu.tsx
/**
 * A kebab (⋮) button that opens a menu from a plain item list.
 */
import type { ComponentType, ReactNode } from "react";
import { EllipsisVertical } from "lucide-react";

import { IconButton, type ButtonVariant } from "./Button";
import { Menu, MenuItem, MenuSeparator, usePopover } from "./Menu";

/**
 * A union rather than one optional-everything shape, so a divider is written
 * `{ separator: true }` instead of carrying a meaningless label and onClick.
 */
export type OverflowMenuItem =
  | { separator: true }
  | {
      separator?: false;
      label: string;
      icon?: ComponentType<{ className?: string }>;
      onClick: () => void;
      /** Destructive actions read red and sit below a divider by convention. */
      danger?: boolean;
      disabled?: boolean;
      /**
       * Second line under the label, for an item that has to explain itself.
       * Rendered rather than left to `title`: a disabled button takes no pointer
       * events, so its tooltip never appears — and there are no tooltips on touch.
       */
      hint?: string;
    };

/**
 * What `items` accepts. Exported so a builder can annotate its return type instead of
 * casting: the annotation is what keeps `{ separator: true }` from widening to
 * `boolean`, and a `.filter(Boolean) as OverflowMenuItem[]` would suppress checking of
 * the whole literal to do a job this component already does.
 */
export type OverflowMenuItems = (OverflowMenuItem | false | null | undefined)[];

type Props = {
  /** Falsy entries are dropped, so call sites can inline `cond && {…}`. */
  items: OverflowMenuItems;
  /** Tooltip and accessible name for the trigger. */
  title: string;
  /** Trigger look; ghost unless the row calls for a surface button */
  variant?: ButtonVariant;
  className?: string;
  /**
   * What the trigger draws, defaulting to the kebab.
   *
   * For a toolbar that already speaks in glyphs: the button means the same thing
   * whether it acts once or offers a choice, so it must keep the same picture rather
   * than turn into a kebab as soon as there are two options. A node rather than an
   * icon-plus-size pair, so sizing stays with the glyph at the call site.
   */
  trigger?: ReactNode;
};

export default function OverflowMenu({
  items: rawItems,
  title,
  variant,
  className,
  trigger = <EllipsisVertical />,
}: Props) {
  const items = rawItems.filter(Boolean) as OverflowMenuItem[];
  const menu = usePopover();

  return (
    <>
      <IconButton
        {...menu.trigger}
        title={title}
        aria-label={title}
        variant={variant}
        className={`menu__trigger ${className ?? ""}`}
      >
        {trigger}
      </IconButton>

      {/* Right-aligned to the trigger: the kebab sits at the end of a row, so a
          left-aligned menu would hang off the edge more often than not. */}
      <Menu {...menu.popover} align="end">
        {items.map((item, i) =>
          item.separator ? (
            <MenuSeparator key={`sep-${i}`} />
          ) : (
            <MenuItem
              key={item.label}
              disabled={item.disabled}
              tone={item.danger ? "danger" : undefined}
              icon={item.icon && <item.icon />}
              hint={item.hint}
              onClick={item.onClick}
            >
              {item.label}
            </MenuItem>
          ),
        )}
      </Menu>
    </>
  );
}

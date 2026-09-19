// The table primitive: renders the `.table` classes in styles/components.css.
// The table carries the design — density, face, the stuck head, the row hover —
// and its cells carry only alignment and tone, so `<th>` and `<td>` stay bare.
// A row that is the current position sets `aria-current`; a cell that must stay
// in view while the table scrolls sideways takes `table__pin`.

import { forwardRef, type TableHTMLAttributes } from "react";

export type TableSize = "sm" | "md";

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** `md` is read a row at a time, 24 px rows ruled apart; `sm` is the dense data table, 20 px rows and no rules */
  size?: TableSize;
  /** The body in the data face; the head stays in the UI face */
  mono?: boolean;
  /** The head stays put while the container behind it scrolls */
  sticky?: boolean;
  /** Rows tint under the pointer */
  hover?: boolean;
}

export const Table = forwardRef<HTMLTableElement, TableProps>(
  ({ size = "md", mono = false, sticky = false, hover = false, className = "", ...rest }, ref) => {
    const classes = [
      "table",
      size !== "md" && `table--${size}`,
      mono && "table--mono",
      sticky && "table--sticky",
      hover && "table--hover",
      className,
    ];
    return <table ref={ref} className={classes.filter(Boolean).join(" ")} {...rest} />;
  },
);
Table.displayName = "Table";

import type { ReactNode } from "react";

import { EmptyState } from "./primitives";
import type { IconName } from "./Icon";

/** Column definition for the data table. */
export interface Column<T> {
  /** Column header label. */
  header: ReactNode;
  /** Cell renderer for one row. */
  render: (row: T) => ReactNode;
  /** Horizontal alignment. Defaults to left. */
  align?: "left" | "right";
  /** Optional fixed width. */
  width?: string | number;
}

/** Props accepted by DataTable. */
interface DataTableProps<T> {
  /** Column definitions. */
  columns: Column<T>[];
  /** Row data. */
  rows: T[];
  /** Stable key extractor. */
  rowKey: (row: T) => string;
  /** Optional row click handler. */
  onRowClick?: (row: T) => void;
  /** Empty-state configuration. */
  empty?: { icon?: IconName; title: string; message?: string };
}

/**
 * Generic, hover-highlighting data table with sticky headers.
 *
 * @param props - Columns, rows, key extractor, click handler, and empty state.
 * @returns The rendered table or an empty state.
 */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, empty }: DataTableProps<T>): React.ReactElement {
  if (rows.length === 0) {
    return <EmptyState icon={empty?.icon ?? "search"} title={empty?.title ?? "Nothing to show"} message={empty?.message} />;
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index} style={{ textAlign: column.align ?? "left", width: column.width }}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className={onRowClick ? "is-clickable" : ""} onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {columns.map((column, index) => (
                <td key={index} style={{ textAlign: column.align ?? "left" }}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

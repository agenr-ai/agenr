import { Fragment, type KeyboardEvent, type ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
  headerClassName?: string;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyMessage?: string;
  loading?: boolean;
  loadingMessage?: string;
  error?: string | null;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  loadMoreLabel?: string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  expandedRowKey?: string | null;
  renderExpandedRow?: (row: T) => ReactNode;
  expandedRowClassName?: string;
  expandedCellClassName?: string;
}

function joinClasses(...classes: Array<string | undefined | false>): string {
  return classes.filter(Boolean).join(" ");
}

export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyMessage = "No results.",
  loading = false,
  loadingMessage = "Loading...",
  error = null,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  loadMoreLabel = "Load More",
  onRowClick,
  rowClassName,
  expandedRowKey = null,
  renderExpandedRow,
  expandedRowClassName,
  expandedCellClassName,
}: DataTableProps<T>) {
  const colSpan = Math.max(1, columns.length);
  const hasRows = rows.length > 0;
  const showLoading = loading && !hasRows && !error;
  const showEmpty = !loading && !hasRows && !error;
  const showOnlyError = !loading && !hasRows && Boolean(error);
  const showInlineError = hasRows && Boolean(error);
  const isRowInteractive = typeof onRowClick === "function";

  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (!isRowInteractive) {
      return;
    }
    if (event.target !== event.currentTarget) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onRowClick(row);
    }
  };

  return (
    <div>
      <div className="overflow-hidden rounded-xl border border-app-border bg-app-surface-soft">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-app-input-bg text-xs uppercase tracking-wide text-app-text-subtle">
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    className={joinClasses("px-4 py-3 text-left font-medium", column.headerClassName)}
                    scope="col"
                  >
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {showOnlyError ? (
                <tr className="border-t border-red-300 dark:border-red-400/20 bg-red-50 dark:bg-red-500/10">
                  <td colSpan={colSpan} className="px-4 py-6 text-center text-sm text-red-700 dark:text-red-200">
                    {error}
                  </td>
                </tr>
              ) : null}

              {showLoading ? (
                <tr className="border-t border-app-border">
                  <td colSpan={colSpan} className="px-4 py-6 text-center text-sm text-app-text-subtle">
                    {loadingMessage}
                  </td>
                </tr>
              ) : null}

              {showEmpty ? (
                <tr className="border-t border-app-border">
                  <td colSpan={colSpan} className="px-4 py-6 text-center text-sm text-app-text-subtle">
                    {emptyMessage}
                  </td>
                </tr>
              ) : null}

              {rows.map((row) => {
                const key = rowKey(row);
                const isExpanded = renderExpandedRow && expandedRowKey === key;
                const expandedContent = isExpanded && renderExpandedRow ? renderExpandedRow(row) : null;

                return (
                  <Fragment key={key}>
                    <tr
                      tabIndex={isRowInteractive ? 0 : undefined}
                      onClick={isRowInteractive ? () => onRowClick(row) : undefined}
                      onKeyDown={isRowInteractive ? (event) => handleKeyDown(event, row) : undefined}
                      className={joinClasses(
                        "border-t border-app-border transition-colors hover:bg-app-surface-soft",
                        isRowInteractive && "cursor-pointer outline-none focus-visible:bg-app-surface-soft",
                        rowClassName?.(row),
                      )}
                    >
                      {columns.map((column) => (
                        <td key={column.key} className={joinClasses("px-4 py-3 text-sm text-app-text-muted", column.className)}>
                          {column.render(row)}
                        </td>
                      ))}
                    </tr>

                    {expandedContent ? (
                      <tr className={joinClasses("border-t border-app-border bg-app-surface", expandedRowClassName)}>
                        <td colSpan={colSpan} className={joinClasses("px-4 py-4", expandedCellClassName)}>
                          {expandedContent}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}

              {showInlineError ? (
                <tr className="border-t border-red-300 dark:border-red-400/20 bg-red-50 dark:bg-red-500/10">
                  <td colSpan={colSpan} className="px-4 py-3 text-sm text-red-700 dark:text-red-200">
                    {error}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {hasMore && onLoadMore ? (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="rounded-lg border border-app-border-strong px-3 py-2 text-xs font-medium text-app-text-muted transition hover:border-blue-400 dark:hover:border-blue-400/60 hover:text-blue-700 dark:hover:text-blue-200 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {loadingMore ? "Loading..." : loadMoreLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

import type { InsertToPosition } from '@blocksuite/affine/shared/utils';
import type { Row } from '@blocksuite/data-view';
import { TableRow, TableSingleView, type TableViewData } from '@blocksuite/data-view/view-presets';
import { moveQueryRow, queryRowsInOrder } from '../../shared/query-order';

export type QueryTableData = TableViewData & { manualRowOrder?: string[] };

export class QueryTableView extends TableSingleView {
  override rowsMapping(rows: Row[]) {
    const order = (this.data$.value as QueryTableData | undefined)?.manualRowOrder ?? [];
    // Native filtering, field sorting and grouping still operate on the ordered rows.
    return super.rowsMapping(queryRowsInOrder(rows, order, row => row.rowId));
  }
  moveRow(row: string, position: InsertToPosition) {
    if (this.readonly$.value) return;
    const order = moveQueryRow((this.data$.value as QueryTableData | undefined)?.manualRowOrder ?? [], this.dataSource.rows$.value, row, position);
    if (!order) return;
    this.lockRows(false);
    this.dataUpdate(() => ({ manualRowOrder: order } as Partial<QueryTableData>));
  }
  override rowGetOrCreate(row: string) { return new QueryTableRow(this, row); }
}

class QueryTableRow extends TableRow {
  override move(position: InsertToPosition, fromGroup?: string, toGroup?: string) {
    if (this.tableView.readonly$.value) return;
    if (toGroup != null) { super.move(position, fromGroup, toGroup); return; }
    (this.tableView as QueryTableView).moveRow(this.rowId, position);
  }
}

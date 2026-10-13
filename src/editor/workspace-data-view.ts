import { CaptionedBlockComponent } from '@blocksuite/affine/components/caption';
import { addProperty, DatabaseBlockDataSource, DatabaseSelection } from '@blocksuite/affine/blocks/database';
import type { DataViewBlockModel } from '@blocksuite/affine/blocks/data-view';
import type { DatabaseBlockModel, ListBlockModel } from '@blocksuite/affine/model';
import { createIdentifier } from '@blocksuite/affine/global/di';
import { RANGE_SYNC_EXCLUDE_ATTR } from '@blocksuite/affine/std/inline';
import { RefNodeSlotsProvider } from '@blocksuite/affine/inlines/reference';
import { FeatureFlagService } from '@blocksuite/affine/shared/services';
import { isInsideBlockByFlavour, type InsertToPosition } from '@blocksuite/affine/shared/utils';
import { SlashMenuConfigExtension, type SlashMenuConfig } from '@blocksuite/affine/widgets/slash-menu';
import {
  DataViewRootUILogic, type DataViewSelection, type DataViewWidgetProps,
  defineUniComponent, renderUniLit,
} from '@blocksuite/data-view';
import { widgetPresets } from '@blocksuite/data-view/widget-presets';
import { BlockViewIdentifier, type EditorHost } from '@blocksuite/affine/std';
import { Text, type Doc, type ExtensionType, type Store } from '@blocksuite/affine/store';
import { computed, signal } from '@preact/signals-core';
import { html } from 'lit';
import { literal } from 'lit/static-html.js';
import { Subscription } from 'rxjs';
import type { ProductionDoc, ProductionWorkspace } from '../app/workspace';
import { documentUrl } from '../../shared/document-links';
import { QueryIndex, queryRowKey } from '../../shared/query-index';
import { QueryTableView } from './query-table';

type QueryRow = { doc: Doc; model: ListBlockModel };
const completed = 'query-completed', source = 'query-source';

/** The pinned query block is unfinished upstream. Reuse the complete native
 * database engine, views and property editors against its separate block schema.
 */
export class WorkspaceTodoSource extends DatabaseBlockDataSource {
  private readonly rowMap = signal(new Map<string, QueryRow>());
  private index: QueryIndex<Doc, ListBlockModel>;
  private readonly lifetime = new Subscription();
  private stopQueries?: () => void;
  private workspace: ProductionWorkspace;

  override rows$ = computed(() => [...this.rowMap.value.keys()]);
  override properties$ = computed(() => ['title', completed, source, ...this.query.props.columns$.value.map(column => column.id)]);
  override viewMetaGet(type: string) {
    const native = super.viewMetaGet(type);
    return type === 'table' ? { ...native, model: { ...native.model, dataViewManager: QueryTableView } } : native;
  }

  constructor(readonly query: DataViewBlockModel) {
    // Only the common columns, cells and views are accessed by inherited methods.
    super(query as unknown as DatabaseBlockModel);
    this.workspace = query.store.workspace as ProductionWorkspace;
    this.index = new QueryIndex({
      blocks: doc => {
        if ((doc as Partial<ProductionDoc>).sync?.isBlocked) return [];
        return Object.values(doc.getStore().blocks.peek()).map(block => block.model as ListBlockModel).filter(model => model.flavour === 'affine:list' && model.props.type === 'todo');
      },
      subscribe: (doc, update) => { const subscription = doc.getStore().slots.blockUpdated.subscribe(update); return () => subscription.unsubscribe(); },
      changed: rows => { this.rowMap.value = rows; },
    });
    this.lifetime.add(this.workspace.slots.docListUpdated.subscribe(() => this.reconcile()));
    this.reconcile();
    this.stopQueries = this.workspace.watchQueries?.();
  }
  private reconcile() {
    this.index.reconcile(this.workspace.docs.values());
  }
  dispose() {
    this.stopQueries?.(); this.lifetime.unsubscribe();
    this.index.dispose();
  }
  row(id: string) { return this.rowMap.value.get(id); }
  override isFixedProperty(id: string) { return id === completed || id === source || super.isFixedProperty(id); }
  override propertyTypeGet(id: string) { return id === completed ? 'checkbox' : id === source ? 'link' : super.propertyTypeGet(id); }
  override propertyNameGet(id: string) { return id === completed ? '完成' : id === source ? '来源文档' : super.propertyNameGet(id); }
  override propertyDataGet(id: string) { return id === completed || id === source ? {} : super.propertyDataGet(id); }
  override propertyDataTypeGet(id: string) {
    if (id !== completed && id !== source) return super.propertyDataTypeGet(id);
    return this.propertyMetaGet(this.propertyTypeGet(id)!)?.config.jsonValue.type({ data: {}, dataSource: this });
  }
  override propertyReadonlyGet(id: string) { return id === 'title' || id === source || super.propertyReadonlyGet(id); }
  override spacialValueGet(id: string, property: string, type: string) {
    if (type === 'created-time') return this.row(id)?.model.props['meta:createdAt'] ?? null;
    return super.spacialValueGet(id, property, type);
  }
  override cellValueGet(id: string, property: string): unknown {
    const row = this.rowMap.value.get(id);
    if (!row) return;
    if (property === 'title') return row.model.text;
    if (property === completed) return row.model.props.checked === true;
    if (property === source) return new URL(documentUrl(row.doc.id, { mode: 'page', blockIds: [row.model.id] }), location.origin).href;
    if (this.propertyTypeGet(property) === 'created-time') return this.spacialValueGet(id, property, 'created-time');
    // Accept the published query schema's primitive cells as well as native database cells.
    const cell = this.query.props.cells[id]?.[property];
    if (cell != null && (typeof cell !== 'object' || !('columnId' in cell))) return cell;
    return super.cellValueGet(id, property);
  }
  override cellValueChange(id: string, property: string, value: unknown) {
    if (this.readonly$.value || property === 'title' || property === source) return;
    if (property !== completed) { super.cellValueChange(id, property, value); return; }
    const row = this.row(id);
    if (row) this.changeSource(row, store => {
      const model = store.getModelById(row.model.id);
      if (model?.flavour === 'affine:list' && (model as ListBlockModel).props.type === 'todo') store.updateBlock(model, { checked: value === true });
    });
  }
  private changeSource(row: QueryRow, change: (store: Store) => void) {
    if (this.workspace.editQuerySource) void this.workspace.editQuerySource(row.doc.id, change).catch(error => this.workspace.report(error));
    else if (!row.doc.getStore().readonly) change(row.doc.getStore());
  }
  override rowAdd(): string {
    if (this.readonly$.value) return '';
    const parent = this.doc.getParent(this.query);
    if (!parent) return '';
    this.doc.captureSync();
    const id = this.doc.addBlock('affine:list', { type: 'todo', checked: false, text: new Text('新待办') }, parent);
    return queryRowKey(this.doc, { id });
  }
  override rowDelete(ids: string[]) {
    if (this.readonly$.value) return;
    for (const id of ids) {
      const row = this.row(id);
      if (row) this.changeSource(row, store => { const block = store.getModelById(row.model.id); if (block) store.deleteBlock(block); });
    }
  }
  override rowMove(id: string, position: InsertToPosition) {
    const view = this.viewManager.currentView$.value;
    if (!this.readonly$.value && view instanceof QueryTableView) view.moveRow(id, position);
  }
  override propertyDuplicate(id: string) {
    if (this.readonly$.value || this.isFixedProperty(id)) return;
    const column = this.query.props.columns.find(column => column.id === id);
    if (!column) return;
    const names = new Set(this.query.props.columns.map(column => column.name));
    let suffix = 1;
    while (names.has(`${column.name}(${suffix})`)) suffix++;
    this.doc.captureSync();
    let copy: string;
    this.doc.transact(() => {
      copy = addProperty(this.query as unknown as DatabaseBlockModel, { id, before: false }, { ...column, id: this.workspace.idGenerator(), name: `${column.name}(${suffix})` });
      for (const cells of Object.values(this.query.props.cells)) {
        if (!Object.hasOwn(cells, id)) continue;
        const cell = cells[id];
        const value = cell != null && typeof cell === 'object' && 'columnId' in cell ? ('value' in cell ? cell.value : undefined) : cell;
        cells[copy] = { columnId: copy, value: value instanceof Text ? value.clone() : value };
      }
    });
    return copy!;
  }
}

class WorkspaceDataView extends CaptionedBlockComponent<DataViewBlockModel> {
  private source?: WorkspaceTodoSource;
  private logic?: DataViewRootUILogic;
  get dataSource() {
    if (!this.source) {
      this.source = new WorkspaceTodoSource(this.model);
      this.source.serviceSet(createIdentifier<EditorHost>('editor-host'), this.host);
    }
    return this.source;
  }
  private setSelection = (viewSelection: DataViewSelection | undefined) => this.selection.setGroup('note', viewSelection ? [new DatabaseSelection({ blockId: this.blockId, viewSelection })] : []);
  private readonly tools = widgetPresets.createTools({
    table: [widgetPresets.tools.filter, widgetPresets.tools.sort, widgetPresets.tools.search, widgetPresets.tools.viewOptions, widgetPresets.tools.tableAddRow],
    kanban: [widgetPresets.tools.filter, widgetPresets.tools.sort, widgetPresets.tools.search, widgetPresets.tools.viewOptions, widgetPresets.tools.tableAddRow],
  });
  private readonly header = defineUniComponent((props: DataViewWidgetProps) => html`
    <div class="workspace-query-header">
      <input aria-label="待办汇总标题" placeholder="待办汇总" .value=${this.model.props.title} ?readonly=${this.store.readonly}
        @change=${(event: Event) => { if (!this.store.readonly) this.store.updateBlock(this.model, { title: (event.target as HTMLInputElement).value }); }}>
      <div>${renderUniLit(widgetPresets.viewBar, props)}${renderUniLit(this.tools, props)}</div>
      ${renderUniLit(widgetPresets.quickSettingBar, props)}
      <p role="status">${(this.store.workspace as ProductionWorkspace).queryState?.value ?? (this.store.workspace.id === 'snapshot' ? '离线稿预览仅显示本篇待办，其他来源请返回工作区查看' : '当前工作区待办')}</p>
    </div>`);
  private get rootLogic() {
    return this.logic ??= new DataViewRootUILogic({
      virtualPadding$: signal(0), dataSource: this.dataSource, headerWidget: this.header,
      clipboard: this.std.clipboard,
      bindHotkey: hotkeys => ({ dispose: this.host.event.bindHotkey(hotkeys, { blockId: this.blockId }) }),
      handleEvent: (name, handler) => ({ dispose: this.host.event.add(name, handler, { blockId: this.blockId }) }),
      selection$: computed(() => this.selection.value.find((item): item is DatabaseSelection => item instanceof DatabaseSelection && item.blockId === this.blockId)?.viewSelection),
      setSelection: this.setSelection,
      notification: { toast: message => (this.store.workspace as ProductionWorkspace).report?.(new Error(message)) },
      eventTrace: () => {},
      detailPanelConfig: { openDetailPanel: async (_target, { rowId }) => {
        const row = this.dataSource.row(rowId);
        if (row) this.std.get(RefNodeSlotsProvider).docLinkClicked.next({ pageId: row.doc.id, params: { mode: 'page', blockIds: [row.model.id] }, host: this.host });
      } },
    });
  }
  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute(RANGE_SYNC_EXCLUDE_ATTR, 'true');
    if (!this.model.props.views.length && !this.store.readonly) this.dataSource.viewManager.viewAdd('table');
  }
  override disconnectedCallback() {
    this.source?.dispose(); this.source = undefined; this.logic = undefined;
    super.disconnectedCallback();
  }
  override renderBlock() { return html`<div contenteditable="false">${this.rootLogic.render()}</div>`; }
}
customElements.define('page-together-data-view', WorkspaceDataView);
// The pinned package ships a Todo menu configuration but never registers it.
// Use the public menu API and let the native view initialize its default table.
const workspaceTodoMenu: SlashMenuConfig = {
  disableWhen: ({ model }) => model.flavour === 'affine:data-view',
  items: [{
    name: 'Todo', description: 'Summarize tasks across documents.', searchAlias: ['todo view', '待办汇总'],
    icon: html`<span aria-hidden="true">☑</span>`, group: '7_Database@1',
    when: ({ model, std }) => !model.store.readonly && !isInsideBlockByFlavour(model.store, model, 'affine:edgeless-text') && !!std.get(FeatureFlagService).getFlag('enable_block_query'),
    action: ({ model }) => {
      const store = model.store, parent = store.getParent(model);
      if (store.readonly || !parent) return;
      store.captureSync();
      store.addBlock('affine:data-view', { title: '待办汇总' }, parent, parent.children.indexOf(model) + 1);
      if (model.text?.length === 0) store.deleteBlock(model);
    },
  }],
};
export const WorkspaceDataViewExtension: ExtensionType = {
  setup(di) {
    di.override(BlockViewIdentifier('affine:data-view'), literal`page-together-data-view`);
    SlashMenuConfigExtension('page-together-todo', workspaceTodoMenu).setup(di);
  },
};

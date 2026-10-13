/** Narrow source compatibility patch for the pinned native data-view component.
 * Keep the native models, evaluator and menus; fail if the upstream source drifts.
 */
export const nativeFilterGroupPath = '/@blocksuite/data-view/src/widget-presets/quick-setting-bar/filter/group-panel-view.ts';
export const nativeNumberCellPath = '/@blocksuite/data-view/src/property-presets/number/cell-renderer.ts';
export const nativeLinkCellPath = '/@blocksuite/affine-block-database/src/properties/link/cell-renderer.ts';
export const nativeTableManagerPath = '/@blocksuite/data-view/src/view-presets/table/table-view-manager.ts';
export const nativeKanbanManagerPath = '/@blocksuite/data-view/src/view-presets/kanban/kanban-view-manager.ts';
export const nativeImageCellPath = '/@blocksuite/data-view/src/property-presets/image/cell-renderer.ts';
export const nativeKanbanCardPath = '/@blocksuite/data-view/src/view-presets/kanban/pc/card.ts';

function replaceOnce(source: string, before: string, after: string) {
  if (source.split(before).length !== 2) throw new Error('BlockSuite data view compatibility source changed; review the pinned version before building');
  return source.replace(before, after);
}

const originalAdd = `    if (this.isMaxDepth) {
      this.onChange({
        ...this.filterGroup.value,
        conditions: [
          ...this.filterGroup.value.conditions,
          firstFilter(this.vars.value),
        ],
      });
      return;
    }
    popAddNewFilter(popupTargetFromElement(e.currentTarget as HTMLElement), {
      value: this.filterGroup.value,
      onChange: this.onChange,
      vars: this.vars.value,
    });`;

const selectableAdd = `    const append = (filter: Filter) => this.onChange({
      ...this.filterGroup.value,
      conditions: [...this.filterGroup.value.conditions, filter],
    });
    const items = this.vars.value.map(variable => menu.action({
      name: variable.name,
      select: () => append(firstFilterByRef(this.vars.value, { type: 'ref', name: variable.id })),
    }));
    if (!this.isMaxDepth) items.push(menu.action({
      name: 'Add filter group',
      select: () => append(firstFilterInGroup(this.vars.value)),
    }));
    popFilterableSimpleMenu(popupTargetFromElement(e.currentTarget as HTMLElement), items);`;

export function patchNativeFilterGroups(source: string, version: string): string {
  if (version !== '0.22.4') throw new Error('Review native filter compatibility before upgrading BlockSuite');
  let result = replaceOnce(source, 'computed(() => filter)', 'computed(() => this.conditions$.value[i] as FilterGroup)');
  result = replaceOnce(result, 'import { firstFilter, firstFilterInGroup }', 'import { firstFilter, firstFilterByRef, firstFilterInGroup }');
  return replaceOnce(result, originalAdd, selectableAdd);
}

export function patchNativeNumberCell(source: string, version: string): string {
  if (version !== '0.22.4') throw new Error('Review native number compatibility before upgrading BlockSuite');
  let result = replaceOnce(source, '    if (!str) {', `    if (this.value != undefined && str === this._getFormattedString(this.value)) return;
    if (!str) {`);
  result = replaceOnce(result, `    const value = enableNewFormatting ? parseNumber(str) : parseFloat(str);`, `    const parsed = enableNewFormatting ? parseNumber(str) : parseFloat(str);
    const value = enableNewFormatting && this.property.data$.value.format === 'percent' && str.includes('%') ? parsed / 100 : parsed;`);
  result = replaceOnce(result, `const formatted = this.value ? this._getFormattedString(this.value) : '';`, `const formatted = this.value != undefined ? this._getFormattedString(this.value) : '';`);
  return replaceOnce(result, `this._inputEle.value = this.value
          ?`, `this._inputEle.value = this.value != undefined
          ?`);
}

export function patchNativeLinkCell(source: string, version: string): string {
  if (version !== '0.22.4') throw new Error('Review native link compatibility before upgrading BlockSuite');
  return replaceOnce(source, '      pageId: this.docId$.value,\n      host: std.host,', '      pageId: this.docId$.value,\n      params: this.parseDocUrl(this.value ?? \'\'),\n      host: std.host,');
}

export function patchNativeHiddenFilters(source: string, version: string): string {
  if (version !== '0.22.4') throw new Error('Review hidden-property filtering before upgrading BlockSuite');
  return replaceOnce(source, 'this.properties$.value.map(column => [', 'this.propertiesRaw$.value.map(column => [');
}

export function patchNativeImageCell(source: string, version: string): string {
  if (version !== '0.22.4') throw new Error('Review empty-image rendering before upgrading BlockSuite');
  return replaceOnce(source, "return html`<img src=${this.value ?? ''}></img>`;", "return this.value ? html`<img src=${this.value}></img>` : html``;");
}

export function patchNativeKanbanCover(source: string, version: string): string {
  if (version !== '0.22.4') throw new Error('Review kanban image covers before upgrading BlockSuite');
  source = replaceOnce(source, '  private renderHeader(columns: KanbanColumn[]) {', '  private renderHeader(columns: KanbanColumn[]) {\n    const cover = this.view.getHeaderCover(this.cardId);\n    const image = cover?.cellGetOrCreate(this.cardId).value$.value;');
  return replaceOnce(source, '      <div class="${classList}">${this.renderTitle()} ${this.renderIcon()}</div>', '      ${typeof image === \'string\' && image ? html`<img class="page-together-kanban-cover" src=${image} alt="图片封面" draggable="false" style="display:block;width:100%;max-height:160px;object-fit:contain">` : html``}\n      <div class="${classList}">${this.renderTitle()} ${this.renderIcon()}</div>');
}

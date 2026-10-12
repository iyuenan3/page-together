/** Narrow source compatibility patch for the pinned native data-view component.
 * Keep the native models, evaluator and menus; fail if the upstream source drifts.
 */
export const nativeFilterGroupPath = '/@blocksuite/data-view/src/widget-presets/quick-setting-bar/filter/group-panel-view.ts';
export const nativeNumberCellPath = '/@blocksuite/data-view/src/property-presets/number/cell-renderer.ts';

function replaceOnce(source: string, before: string, after: string) {
  if (source.split(before).length !== 2) throw new Error('BlockSuite filter compatibility source changed; review the pinned version before building');
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

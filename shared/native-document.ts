import * as Y from 'yjs';

/** BlockSuite 0.22.4's four-block default, without a browser or test workspace. */
export function emptyNativeDocument(title: string, writer: string, now: number) {
  const doc = new Y.Doc(), blocks = doc.getMap<Y.Map<unknown>>('blocks');
  const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
  function native(value: unknown): unknown {
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      const map = new Y.Map<unknown>();
      for (const [key, child] of Object.entries(value)) map.set(key, native(child));
      return map;
    }
    return value;
  }
  function block(index: number, flavour: string, version: number, children: string[], props: Record<string, unknown>) {
    const value = new Y.Map<unknown>();
    value.set('sys:id', ids[index]); value.set('sys:flavour', flavour); value.set('sys:version', version);
    const childIds = new Y.Array<string>(); childIds.push(children); value.set('sys:children', childIds);
    for (const [key, prop] of Object.entries(props)) value.set('prop:' + key, native(prop));
    blocks.set(ids[index], value);
  }
  doc.transact(() => {
    block(0, 'affine:page', 2, [ids[1], ids[2]], { title: new Y.Text(title) });
    // Surface elements use the native boxed Y.Map representation.
    block(1, 'affine:surface', 5, [], { elements: { type: '$blocksuite:internal:native$', value: new Y.Map() } });
    block(2, 'affine:note', 1, [ids[3]], {
      xywh: '[0,0,498,92]', background: { light: '#ffffff', dark: '#252525' }, index: 'a0',
      lockedBySelf: false, hidden: false, displayMode: 'both',
      edgeless: { style: { borderRadius: 8, borderSize: 4, borderStyle: 'none', shadowType: '--affine-note-shadow-box' } },
    });
    block(3, 'affine:paragraph', 1, [], {
      type: 'text', text: new Y.Text(), collapsed: false,
      'meta:createdAt': now, 'meta:createdBy': writer, 'meta:updatedAt': now, 'meta:updatedBy': writer,
    });
  });
  return doc;
}

/** Even deleted content has a state vector, and must never be reinitialized. */
export function hasDocumentHistory(doc: Y.Doc) { return Y.decodeStateVector(Y.encodeStateVector(doc)).size > 0; }
export function nativeRootIds(doc: Y.Doc) {
  return [...doc.getMap<Y.Map<unknown>>('blocks').entries()].filter(([, block]) => block instanceof Y.Map && block.get('sys:flavour') === 'affine:page').map(([id]) => id);
}
export function createsNativeRoot(update: Uint8Array) {
  return Y.decodeUpdate(update).structs.some(item => item instanceof Y.Item && item.parentSub === 'sys:flavour' && item.content.getContent().includes('affine:page'));
}

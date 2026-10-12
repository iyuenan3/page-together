import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates, type Awareness } from 'y-protocols/awareness.js';
import { encodePresence } from '../../shared/awareness.js';
import type { Member } from '../../shared/protocol.js';

export interface OnlineMember { id: string; name: string; color: string; devices: number }
export class DocumentPresence {
  connected = false;
  active = false;
  onChange = () => {};
  private timer?: ReturnType<typeof setTimeout>;
  private readonly remoteOrigin = {};
  constructor(readonly awareness: Awareness, private send: (bytes: Uint8Array) => void) {
    awareness.on('update', this.updated); awareness.on('change', this.changed);
  }
  private changed = () => this.onChange();
  private updated = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === this.remoteOrigin || !this.connected || ![...added, ...updated, ...removed].includes(this.awareness.clientID) || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.publish(); }, 80);
  };
  private publish() {
    if (!this.connected) return;
    if (this.active) this.send(encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]));
    else this.send(encodePresence(this.awareness.clientID, this.awareness.meta.get(this.awareness.clientID)?.clock ?? 0, null));
  }
  setActive(active: boolean) {
    this.active = active;
    this.awareness.setLocalState({ ...this.awareness.getLocalState(), selectionV2: {} });
    this.publish(); this.onChange();
  }
  open() {
    this.connected = true;
    this.awareness.setLocalState({ ...this.awareness.getLocalState() });
    this.publish(); this.onChange();
  }
  receive(bytes: Uint8Array) { applyAwarenessUpdate(this.awareness, bytes, this.remoteOrigin); }
  members(): OnlineMember[] {
    if (!this.connected) return [];
    const members = new Map<string, OnlineMember>();
    for (const [id, state] of this.awareness.getStates()) {
      if (id === this.awareness.clientID && !this.active) continue;
      if (typeof state.memberId !== 'string' || typeof state.user?.name !== 'string') continue;
      const previous = members.get(state.memberId);
      members.set(state.memberId, { id: state.memberId, name: state.user.name, color: state.color, devices: (previous?.devices ?? 0) + 1 });
    }
    return [...members.values()];
  }
  identity(member: Member) {
    this.awareness.setLocalStateField('user', { name: member.nickname });
    this.awareness.setLocalStateField('memberId', member.id);
  }
  close() {
    this.connected = false; clearTimeout(this.timer); this.timer = undefined;
    removeAwarenessStates(this.awareness, [...this.awareness.getStates().keys()].filter(id => id !== this.awareness.clientID), this.remoteOrigin);
    this.onChange();
  }
  dispose() { this.close(); this.awareness.off('update', this.updated); this.awareness.off('change', this.changed); }
}

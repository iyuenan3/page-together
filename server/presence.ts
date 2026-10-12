import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness.js';
import { decodePresence, encodePresence, memberPresence } from '../shared/awareness.js';
import type { DocumentScope, Member } from '../shared/protocol.js';
import { requireThat } from './errors.js';

interface Room { scope: DocumentScope; doc: Y.Doc; awareness: Awareness; owners: Map<number, object> }
const key = (scope: DocumentScope) => `${scope.epoch}:${scope.generation}:${scope.docId}`;
export class PresenceRooms {
  private rooms = new Map<string, Room>();
  constructor(private broadcast: (scope: DocumentScope, bytes: Uint8Array) => void) {}
  private room(scope: DocumentScope) {
    let room = this.rooms.get(key(scope));
    if (!room) {
      const doc = new Y.Doc(), awareness = new Awareness(doc);
      awareness.setLocalState(null);
      room = { scope, doc, awareness, owners: new Map() };
      awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const clients = [...added, ...updated, ...removed].filter(id => id !== awareness.clientID);
        if (clients.length) this.broadcast(scope, encodeAwarenessUpdate(awareness, clients));
      });
      this.rooms.set(key(scope), room);
    }
    return room;
  }
  snapshot(scope: DocumentScope) {
    const room = this.room(scope);
    return encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]);
  }
  update(scope: DocumentScope, owner: object, member: Member, bytes: Uint8Array) {
    let value: ReturnType<typeof decodePresence>;
    try { value = decodePresence(bytes); } catch { requireThat(false, 400, 'invalid_awareness'); }
    const room = this.room(scope), { clientId, clock, state } = value!;
    const owned = [...room.owners].find(([, candidate]) => candidate === owner)?.[0];
    requireThat(owned === undefined || owned === clientId, 400, 'awareness_client_changed');
    requireThat(!room.owners.has(clientId) || room.owners.get(clientId) === owner, 403, 'awareness_client_owned');
    requireThat(clientId !== room.awareness.clientID, 400, 'invalid_awareness');
    room.owners.set(clientId, owner);
    applyAwarenessUpdate(room.awareness, encodePresence(clientId, clock, memberPresence(member, state)), owner);
  }
  leave(owner: object) {
    for (const [id, room] of this.rooms) {
      const clients = [...room.owners].filter(([, candidate]) => candidate === owner).map(([client]) => client);
      for (const client of clients) room.owners.delete(client);
      if (clients.length) removeAwarenessStates(room.awareness, clients, 'disconnect');
      if (!room.owners.size) { room.awareness.destroy(); room.doc.destroy(); this.rooms.delete(id); }
    }
  }
  close() {
    for (const room of this.rooms.values()) { room.awareness.destroy(); room.doc.destroy(); }
    this.rooms.clear();
  }
}

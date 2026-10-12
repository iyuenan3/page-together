import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { Member } from './protocol.js';

export const MAX_AWARENESS_BYTES = 16_384;
export function encodePresence(clientId: number, clock: number, state: Record<string, unknown> | null) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1); encoding.writeVarUint(encoder, clientId);
  encoding.writeVarUint(encoder, clock); encoding.writeVarString(encoder, JSON.stringify(state));
  return encoding.toUint8Array(encoder);
}
export function decodePresence(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_AWARENESS_BYTES) throw new Error('awareness_too_large');
  const decoder = decoding.createDecoder(bytes);
  if (decoding.readVarUint(decoder) !== 1) throw new Error('single_awareness_required');
  const clientId = decoding.readVarUint(decoder), clock = decoding.readVarUint(decoder);
  const state: unknown = JSON.parse(decoding.readVarString(decoder));
  if (!Number.isSafeInteger(clientId) || clientId < 0 || clientId > 0xffffffff || !Number.isSafeInteger(clock) || clock < 0 || decoding.hasContent(decoder)) throw new Error('invalid_awareness');
  if (state !== null && (typeof state !== 'object' || Array.isArray(state))) throw new Error('invalid_awareness');
  return { clientId, clock, state: state as Record<string, unknown> | null };
}
const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
function point(value: unknown) {
  const p = value as Record<string, unknown> | null;
  return p && id(p.blockId) && integer(p.index) && integer(p.length);
}
function validSelection(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  switch (s.type) {
    case 'text': return !!point(s.from) && (s.to === null || !!point(s.to)) && (s.reverse === undefined || typeof s.reverse === 'boolean');
    case 'block': case 'image': return id(s.blockId);
    case 'cursor': return typeof s.x === 'number' && Number.isFinite(s.x) && typeof s.y === 'number' && Number.isFinite(s.y);
    case 'surface': return id(s.blockId) && Array.isArray(s.elements) && s.elements.length <= 128 && s.elements.every(id) && typeof s.editing === 'boolean' && (s.inoperable === undefined || typeof s.inoperable === 'boolean');
    default: return false;
  }
}
export function memberPresence(member: Member, state: Record<string, unknown> | null) {
  if (state === null) return null;
  const selectionV2: Record<string, unknown[]> = Object.create(null);
  const selections = state.selectionV2;
  if (selections && typeof selections === 'object' && !Array.isArray(selections)) {
    for (const [key, values] of Object.entries(selections).slice(0, 16)) {
      if (id(key) && Array.isArray(values)) selectionV2[key] = values.slice(0, 128).filter(validSelection);
    }
  }
  const colors = ['#3971c8', '#a34eac', '#22846d', '#b36425', '#b04b6a', '#6360b8'];
  const colorIndex = [...member.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length;
  return { user: { name: member.nickname }, memberId: member.id, role: member.role, color: colors[colorIndex], selectionV2 };
}

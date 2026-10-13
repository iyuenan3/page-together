export const PROTOCOL_VERSION = 1;
export type Role = 'manage' | 'edit' | 'view';
export interface Member {
  id: string;
  nickname: string;
  role: Role;
  owner: boolean;
  active: boolean;
  accessRevision: number;
}
export interface DocumentInfo {
  id: string;
  title: string;
  generation: number;
  revision: number;
  deleted: boolean;
  createdAt: number;
}
export interface DocumentScope {
  docId: string;
  epoch: string;
  generation: number;
}
export interface DocumentRead extends DocumentScope {
  update: string;
  revision: number;
  member: Member;
}
export type ClientMessage = DocumentScope & {
  v: 1;
  requestId: string;
} & (
  | { type: 'open'; stateVector: string }
  | { type: 'push'; update: string }
  | { type: 'awareness'; update: string }
);
export type ServerMessage =
  | { v: 1; type: 'ready'; epoch: string; member: Member }
  | (DocumentScope & { v: 1; type: 'sync'; requestId: string; update: string; stateVector: string; revision: number })
  | (DocumentScope & { v: 1; type: 'saved'; requestId: string; updateHash: string; revision: number })
  | (DocumentScope & { v: 1; type: 'update'; update: string; revision: number })
  | (DocumentScope & { v: 1; type: 'awareness'; update: string })
  | { v: 1; type: 'error'; requestId?: string; code: string }
  | { v: 1; type: 'catalog' };

export const canEdit = (role: Role) => role === 'manage' || role === 'edit';

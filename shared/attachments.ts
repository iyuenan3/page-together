import type { DocumentScope } from './protocol.js';

export const MAX_ATTACHMENT_BYTES = 50_000_000;
export const UPLOAD_CONTEXT_HEADER = 'X-PageTogether-Upload';
export interface BlobWriteContext extends DocumentScope { memberId: string; accessRevision: number }
export const blobWriteHeaders = (context: BlobWriteContext) => ({ [UPLOAD_CONTEXT_HEADER]: JSON.stringify(context) });

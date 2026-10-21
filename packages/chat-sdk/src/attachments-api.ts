import { SwalvoAttachmentError } from './errors';
import type { RestClient } from './internal/rest-client';

export interface AttachmentUploadTicket {
  id: string;
  roomId: string;
  filename: string;
  mimeType: string;
  size: number;
  storageKey: string;
  status: string;
  uploadUrl: string;
  uploadMethod: 'PUT';
  uploadHeaders: Record<string, string>;
  expiresAt: string;
}

/**
 * `chat.attachments.*`.
 *
 * Bytes go straight from the browser to object storage over a short-lived
 * signed URL. They never pass through Swalvo's API and never touch the
 * WebSocket (spec §30). Storage credentials stay server-side, and the
 * browser only ever holds a URL that expires and addresses exactly one
 * object.
 *
 * `upload()` folds the whole three-step dance, ticket → PUT → confirm, into
 * one call. Getting that sequence right by hand is precisely the sort of
 * thing an SDK ought to absorb.
 */
export class AttachmentsApi {
  constructor(
    private readonly rest: RestClient,
    private readonly defaultRoom: () => string,
  ) {}

  /** Step 1 on its own, for callers driving the upload themselves: progress bars, resumable transfers. */
  createUploadTicket(input: {
    filename: string;
    mimeType: string;
    size: number;
    room?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AttachmentUploadTicket> {
    const room = input.room ?? this.defaultRoom();
    return this.rest.request<AttachmentUploadTicket>(`/v1/chat/conversations/${encodeURIComponent(room)}/attachments`, {
      method: 'POST',
      body: {
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.size,
        metadata: input.metadata,
      },
    });
  }

  /**
   * Uploads a file and returns the attachment id to pass as
   * `sendMessage({ attachmentId })`.
   */
  async upload(
    file: File | Blob,
    options: { filename?: string; room?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<AttachmentUploadTicket> {
    const filename = options.filename ?? (file instanceof File ? file.name : 'upload');
    const ticket = await this.createUploadTicket({
      filename,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      room: options.room,
      metadata: options.metadata,
    });

    let response: Response;
    try {
      response = await fetch(ticket.uploadUrl, {
        method: ticket.uploadMethod,
        headers: ticket.uploadHeaders,
        body: file,
      });
    } catch (error) {
      throw new SwalvoAttachmentError('Could not reach object storage to upload the file', 'NETWORK_ERROR', error);
    }

    if (!response.ok) {
      // Don't confirm an upload that never happened. The attachment stays
      // PENDING and can never be attached to a message, which is the right
      // end state for a failed upload.
      throw new SwalvoAttachmentError(
        `Object storage rejected the upload (status ${response.status})`,
        'ATTACHMENT_NOT_FOUND',
      );
    }

    await this.complete(ticket.id);
    return { ...ticket, status: 'uploaded' };
  }

  /** Marks an upload finished, making the attachment sendable. */
  complete(attachmentId: string): Promise<{ id: string; status: string }> {
    return this.rest.request(`/v1/chat/attachments/${encodeURIComponent(attachmentId)}/complete`, {
      method: 'POST',
    });
  }

  /**
   * A short-lived signed download URL. Mint one when the user actually
   * clicks. Don't cache them: they expire, and that expiry is exactly what
   * stops a shared link turning into permanent access.
   */
  getDownloadUrl(attachmentId: string): Promise<{ url: string; expiresAt: string }> {
    return this.rest.request(`/v1/chat/attachments/${encodeURIComponent(attachmentId)}/download-url`);
  }
}

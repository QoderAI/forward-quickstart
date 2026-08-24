import { describe, expect, test } from 'vitest';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_MAX_BYTES,
  IMAGE_ATTACHMENT_MAX_BYTES,
  attachmentMaxBytes,
  attachmentMountPath,
  attachmentRejectReason,
  composeMessageWithAttachments,
  isImageAttachment,
  isImageAttachmentName,
  namePastedImage,
  splitAttachmentMarkers,
} from './attachments';

const MB = 1024 * 1024;

describe('isImageAttachment', () => {
  test('accepts the common camera and screenshot formats by extension', () => {
    for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp', 'f.bmp', 'g.avif', 'h.heic', 'i.heif']) {
      expect(isImageAttachment({ name })).toBe(true);
    }
  });

  test('is case-insensitive about the extension', () => {
    expect(isImageAttachment({ name: 'IMG_1234.JPG' })).toBe(true);
    expect(isImageAttachment({ name: 'Screenshot.PNG' })).toBe(true);
  });

  test('trusts an image MIME type even when the name has no usable extension', () => {
    // HEIC from macOS and clipboard drops often arrive with a bare name.
    expect(isImageAttachment({ name: 'image', type: 'image/heic' })).toBe(true);
    expect(isImageAttachment({ name: 'blob', type: 'image/png' })).toBe(true);
  });

  test('does not treat documents as images', () => {
    for (const name of ['notes.md', 'data.csv', 'main.ts', 'report.pdf']) {
      expect(isImageAttachment({ name })).toBe(false);
    }
  });

  test('treats .svg as a document, not an image', () => {
    // svg stays in the text list: it is editable source and rendering untrusted
    // markup in an <img> is not worth the thumbnail.
    expect(isImageAttachment({ name: 'icon.svg' })).toBe(false);
    expect(isImageAttachmentName('icon.svg')).toBe(false);
    expect(ATTACHMENT_EXTENSIONS).toContain('svg');
  });
});

describe('attachmentRejectReason', () => {
  test('accepts an image that a text file would be too large for', () => {
    const img = { name: 'photo.jpg', type: 'image/jpeg', size: 7 * MB };
    expect(attachmentRejectReason(img)).toBeNull();
    expect(attachmentMaxBytes(img)).toBe(IMAGE_ATTACHMENT_MAX_BYTES);
  });

  test('rejects an image over the 10 MB image cap', () => {
    expect(attachmentRejectReason({ name: 'huge.png', type: 'image/png', size: 11 * MB }))
      .toBe('超过 10 MB 限制');
  });

  test('keeps the 5 MB cap for text files', () => {
    expect(attachmentRejectReason({ name: 'big.log', size: 6 * MB })).toBe('超过 5 MB 限制');
    expect(attachmentRejectReason({ name: 'ok.log', size: 4 * MB })).toBeNull();
    expect(attachmentMaxBytes({ name: 'ok.log' })).toBe(ATTACHMENT_MAX_BYTES);
  });

  test('accepts a file exactly at its cap and rejects one byte over', () => {
    expect(attachmentRejectReason({ name: 'a.png', size: IMAGE_ATTACHMENT_MAX_BYTES })).toBeNull();
    expect(attachmentRejectReason({ name: 'a.png', size: IMAGE_ATTACHMENT_MAX_BYTES + 1 })).not.toBeNull();
    expect(attachmentRejectReason({ name: 'a.txt', size: ATTACHMENT_MAX_BYTES })).toBeNull();
    expect(attachmentRejectReason({ name: 'a.txt', size: ATTACHMENT_MAX_BYTES + 1 })).not.toBeNull();
  });

  test('still rejects unsupported non-image types', () => {
    expect(attachmentRejectReason({ name: 'archive.zip', size: 1024 })).toBe('类型不支持');
    expect(attachmentRejectReason({ name: 'app.exe', size: 1024 })).toBe('类型不支持');
  });
});

describe('ATTACHMENT_ACCEPT', () => {
  test('advertises image extensions so the OS picker stops filtering them out', () => {
    // This is the actual bug: the picker only listed text extensions, so images
    // were greyed out and could not be chosen at all.
    for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic']) {
      expect(ATTACHMENT_ACCEPT).toContain(ext);
    }
  });

  test('includes the image/* wildcard for formats not enumerated', () => {
    expect(ATTACHMENT_ACCEPT).toContain('image/*');
  });

  test('keeps advertising the text extensions it always did', () => {
    for (const ext of ['.md', '.csv', '.json', '.ts', '.py']) {
      expect(ATTACHMENT_ACCEPT).toContain(ext);
    }
  });
});

describe('attachment markers', () => {
  test('mount path matches the Cloud API default of /data/workspace/<filename>', () => {
    // A new session mounts resources without an explicit mount_path, so the
    // marker has to predict where the file lands.
    expect(attachmentMountPath('secret-code.png')).toBe('/data/workspace/secret-code.png');
  });

  test('uses one identical marker format for images and documents', () => {
    const composed = composeMessageWithAttachments('这张图里写的是什么？', ['chart.png']);
    expect(composed).toBe('这张图里写的是什么？\n\n[附件] chart.png → /data/workspace/chart.png');
  });

  test('can include a file id while preserving the mounted path for the agent', () => {
    const composed = composeMessageWithAttachments('看看这张图', [{ name: 'photo.png', fileId: 'file_abc123' }]);
    expect(composed).toBe('看看这张图\n\n[附件] photo.png → /data/workspace/photo.png · file_id=file_abc123');
    expect(splitAttachmentMarkers(composed).attachments[0]).toMatchObject({
      name: 'photo.png',
      path: '/data/workspace/photo.png',
      fileId: 'file_abc123',
      isImage: true,
    });
  });

  test('round-trips an image attachment and flags it as an image', () => {
    const composed = composeMessageWithAttachments('看看这张图', ['photo.JPG']);
    const { body, attachments } = splitAttachmentMarkers(composed);
    expect(body).toBe('看看这张图');
    expect(attachments).toEqual([
      { name: 'photo.JPG', path: '/data/workspace/photo.JPG', isImage: true },
    ]);
  });

  test('round-trips a mixed set, flagging only the images', () => {
    const composed = composeMessageWithAttachments('对比一下', ['a.png', 'b.csv']);
    const { attachments } = splitAttachmentMarkers(composed);
    expect(attachments.map((a) => [a.name, a.isImage])).toEqual([['a.png', true], ['b.csv', false]]);
  });

  test('leaves a message with no markers untouched', () => {
    expect(splitAttachmentMarkers('就是普通的一句话')).toEqual({ body: '就是普通的一句话', attachments: [] });
  });

  test('an image-only message parses to an empty body', () => {
    // The bubble relies on this to render just the thumbnail with no empty line.
    const { body, attachments } = splitAttachmentMarkers(composeMessageWithAttachments('', ['only.png']));
    expect(body).toBe('');
    expect(attachments).toHaveLength(1);
  });
});

describe('namePastedImage', () => {
  test('names a clipboard screenshot from its MIME type', () => {
    expect(namePastedImage({ name: '', type: 'image/png' }, '2026-08-01T09-00-00', 0, 1))
      .toBe('pasted-2026-08-01T09-00-00.png');
  });

  test('normalizes jpeg to jpg', () => {
    expect(namePastedImage({ name: '', type: 'image/jpeg' }, 'S', 0, 1)).toBe('pasted-S.jpg');
  });

  test('replaces the generic image.png that browsers invent', () => {
    expect(namePastedImage({ name: 'image.png', type: 'image/png' }, 'S', 0, 1)).toBe('pasted-S.png');
  });

  test('keeps a real filename when the clipboard has one', () => {
    expect(namePastedImage({ name: 'Screenshot 2026.png', type: 'image/png' }, 'S', 0, 1))
      .toBe('Screenshot 2026.png');
  });

  test('suffixes an index only when several images are pasted at once', () => {
    expect(namePastedImage({ name: '', type: 'image/png' }, 'S', 0, 2)).toBe('pasted-S-1.png');
    expect(namePastedImage({ name: '', type: 'image/png' }, 'S', 1, 2)).toBe('pasted-S-2.png');
  });

  test('falls back to png when the clipboard reports no type', () => {
    expect(namePastedImage({ name: '', type: '' }, 'S', 0, 1)).toBe('pasted-S.png');
    expect(namePastedImage({}, 'S', 0, 1)).toBe('pasted-S.png');
  });

  test('pasted names survive a marker round-trip as images', () => {
    const name = namePastedImage({ name: '', type: 'image/png' }, '2026-08-01T09-00-00', 0, 1);
    const { attachments } = splitAttachmentMarkers(composeMessageWithAttachments('这是什么', [name]));
    expect(attachments[0].isImage).toBe(true);
  });
});

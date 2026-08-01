// Chat attachment rules and message-marker encoding.
//
// The live Forward API rejects event.file_attachments, so attachments are
// delivered by uploading to the Files API, mounting the file into the agent
// workspace, and appending a marker block to the user message text. The bubble
// parses the marker back into chips, which also keeps attachments visible after
// a history reload (the server stores message text verbatim).
//
// Images travel this exact same path: the Files API accepts image/* uploads and
// the agent's Read tool decodes a mounted image natively (verified against the
// live API — the agent read characters rendered inside a PNG). So the only
// things that differ from a text file are the size cap and how the chip renders.

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
// Photos routinely exceed 5 MB and both the upload proxy and the Files API
// accept more (a 7 MB PNG uploads fine), so images get their own higher cap.
export const IMAGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export const ATTACHMENT_EXTENSIONS = [
  'txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'log',
  'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
  'py', 'go', 'rs', 'java', 'kt', 'scala', 'c', 'cpp', 'cc', 'h', 'hpp', 'rb', 'php',
  'swift', 'r', 'lua', 'pl', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'graphql', 'gql',
  'proto', 'dockerfile', 'makefile', 'gitignore', 'editorconfig', 'eslintrc', 'prettierrc',
  'tex', 'rst', 'adoc', 'org', 'svg',
];

// 'svg' is deliberately absent here while staying in ATTACHMENT_EXTENSIONS: it
// is both editable source text and a renderable image, and treating it as a
// document keeps the stricter text cap and avoids rendering untrusted markup in
// an <img>.
export const IMAGE_ATTACHMENT_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif'];

// What the hidden <input type="file"> advertises. 'image/*' is appended so the
// OS picker also offers camera formats not in the list above.
export const ATTACHMENT_ACCEPT = [
  ...ATTACHMENT_EXTENSIONS.map((ext) => `.${ext}`),
  ...IMAGE_ATTACHMENT_EXTENSIONS.map((ext) => `.${ext}`),
  'image/*',
].join(',');

export function attachmentExt(filename: string): string {
  return (filename.includes('.') ? filename.split('.').pop()! : filename).toLowerCase();
}

/** An attachment is an image when the browser says so, or when the extension
 *  does — HEIC/HEIF frequently arrive with an empty MIME type. */
export function isImageAttachment(file: { name: string; type?: string }): boolean {
  if (file.type && /^image\//i.test(file.type)) return true;
  return IMAGE_ATTACHMENT_EXTENSIONS.includes(attachmentExt(file.name));
}

export function isImageAttachmentName(filename: string): boolean {
  return IMAGE_ATTACHMENT_EXTENSIONS.includes(attachmentExt(filename));
}

/** Per-kind size cap: images may be twice as large as text files. */
export function attachmentMaxBytes(file: { name: string; type?: string }): number {
  return isImageAttachment(file) ? IMAGE_ATTACHMENT_MAX_BYTES : ATTACHMENT_MAX_BYTES;
}

/** Reason a pick was rejected, or null when it is acceptable. */
export function attachmentRejectReason(file: { name: string; type?: string; size: number }): string | null {
  const image = isImageAttachment(file);
  if (!image && !ATTACHMENT_EXTENSIONS.includes(attachmentExt(file.name))) return '类型不支持';
  const max = image ? IMAGE_ATTACHMENT_MAX_BYTES : ATTACHMENT_MAX_BYTES;
  if (file.size > max) return `超过 ${Math.round(max / 1024 / 1024)} MB 限制`;
  return null;
}

// The Cloud API mounts a session file at /data/workspace/<filename> by default,
// and this must match that default: for a brand-new session the client passes
// resources without an explicit mount_path, so the marker has to predict where
// the file lands. (Verified against the live API.)
export function attachmentMountPath(storedName: string): string {
  return `/data/workspace/${storedName}`;
}

// The marker format is intentionally identical for images and documents —
// verified that the agent resolves a mounted image from this plain marker and
// opens it with Read, so there is no need to add a type hint or file id.
export function composeMessageWithAttachments(text: string, storedNames: string[]): string {
  if (storedNames.length === 0) return text;
  const markers = storedNames.map((name) => `[附件] ${name} → ${attachmentMountPath(name)}`);
  return `${text}\n\n${markers.join('\n')}`;
}

const ATTACHMENT_MARKER_RE = /^\[附件\] (.+?) → (\/\S+)$/;

export interface ParsedAttachmentMarker {
  name: string;
  path: string;
  isImage: boolean;
}

export function splitAttachmentMarkers(text: string): { body: string; attachments: ParsedAttachmentMarker[] } {
  const lines = text.split('\n');
  const attachments: ParsedAttachmentMarker[] = [];
  let i = lines.length - 1;
  while (i >= 0) {
    const match = ATTACHMENT_MARKER_RE.exec(lines[i]);
    if (!match) break;
    attachments.unshift({
      name: match[1],
      path: match[2],
      isImage: isImageAttachmentName(match[1]),
    });
    i -= 1;
  }
  if (attachments.length === 0) return { body: text, attachments: [] };
  const body = lines.slice(0, i + 1).join('\n').replace(/\s+$/, '');
  return { body, attachments };
}

/** Clipboard images arrive unnamed (or as a generic "image.png"); give them a
 *  stable, readable filename so the chip and the mount path make sense. */
export function namePastedImage(file: { name?: string; type?: string }, stamp: string, index: number, total: number): string {
  if (file.name && file.name !== 'image.png') return file.name;
  const ext = ((file.type || '').split('/')[1] || 'png').replace('jpeg', 'jpg');
  return `pasted-${stamp}${total > 1 ? `-${index + 1}` : ''}.${ext}`;
}

import type { ReactNode } from 'react';
import { ChatImage } from './chatImage';
import { isImageUrl } from './imageUtils';

function splitTrailingPunctuation(raw: string): { url: string; trailing: string } {
  const match = raw.match(/[.,;:!?)\]}>'"”，。；：！？）】」]+$/);
  if (!match) return { url: raw, trailing: '' };
  return { url: raw.slice(0, -match[0].length), trailing: match[0] };
}

/** Lightweight Markdown renderer — handles common patterns without external deps */
export function renderMarkdown(text: string): ReactNode {
  if (!text) return null;
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push(
        <pre key={key++} className="my-3 overflow-x-auto rounded-lg bg-[#1e1e2e] px-4 py-3 text-[13px] leading-5 text-[#cdd6f4]">
          {lang && <div className="mb-1.5 text-[10px] uppercase tracking-wider text-[#cdd6f4]/40">{lang}</div>}
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = headingMatch[2];
      const cls = level === 1 ? 'text-lg font-bold mt-4 mb-2' : level === 2 ? 'text-base font-bold mt-3 mb-1.5' : 'text-sm font-bold mt-2.5 mb-1';
      blocks.push(<div key={key++} className={cls}>{renderInline(content)}</div>);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="my-2 border-l-3 border-[#3550FF]/30 pl-3 text-black/60 italic">
          {renderInline(quoteLines.join(' '))}
        </blockquote>
      );
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++} className="my-2 list-disc pl-5 space-y-0.5">
          {items.map((item, idx) => <li key={idx}>{renderInline(item)}</li>)}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={key++} className="my-2 list-decimal pl-5 space-y-0.5">
          {items.map((item, idx) => <li key={idx}>{renderInline(item)}</li>)}
        </ol>
      );
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      blocks.push(<hr key={key++} className="my-3 border-black/10" />);
      i++;
      continue;
    }

    // Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Table
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\|?\s*[-:]+[-|:\s]+$/.test(lines[i + 1])) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        const parseRow = (row: string) => row.split('|').slice(1, -1).map(cell => cell.trim());
        const headers = parseRow(tableLines[0]);
        const dataRows = tableLines.slice(2).map(parseRow);
        blocks.push(
          <div key={key++} className="my-3 overflow-x-auto">
            <table className="min-w-full border-collapse border border-gray-200 text-sm">
              <thead>
                <tr className="bg-gray-50">
                  {headers.map((header, idx) => (
                    <th key={idx} className="border border-gray-200 px-3 py-2 text-left font-semibold text-black/70">
                      {renderInline(header)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataRows.map((row, rowIdx) => (
                  <tr key={rowIdx} className={rowIdx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                    {row.map((cell, cellIdx) => (
                      <td key={cellIdx} className="border border-gray-200 px-3 py-2 text-black/70">
                        {renderInline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      continue;
    }

    // Paragraph — collect consecutive non-empty lines
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].trimStart().startsWith('```') && !/^#{1,3}\s/.test(lines[i]) && !/^[-*]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i]) && !lines[i].startsWith('> ') && !/^---+$/.test(lines[i].trim()) && !lines[i].trim().startsWith('|')) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length === 0) {
      // No block matched and the paragraph collector refused this line (e.g. a
      // streaming table header whose separator row hasn't arrived yet, or a bare
      // '## ' with no text). Consume it as plain text to guarantee forward
      // progress — otherwise the while(i) loop spins forever and freezes the tab.
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(<p key={key++} className="my-1.5">{renderInline(paraLines.join(' '))}</p>);
  }

  return <>{blocks}</>;
}

export function renderInline(text: string): ReactNode {
  // Process inline markdown: bold, italic, code, links, images, bare URLs
  const parts: ReactNode[] = [];
  let remaining = text;
  let k = 0;

  while (remaining.length > 0) {
    // Inline code
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push(<code key={k++} className="rounded bg-black/6 px-1.5 py-0.5 font-mono text-[13px]">{codeMatch[1]}</code>);
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Markdown image — 常见图片格式直接内联预览，其他格式回退为链接
    const imageMatch = remaining.match(/^!\[([^\]]*)\]\(([^)\s]+)\)/);
    if (imageMatch) {
      const [, alt, url] = imageMatch;
      parts.push(
        isImageUrl(url)
          ? <ChatImage key={`${k++}-${url}`} src={url} alt={alt} />
          : <a key={k++} href={url} target="_blank" rel="noopener noreferrer" className="break-all text-[#3550FF] underline decoration-[#3550FF]/30 hover:decoration-[#3550FF]">{alt || url}</a>
      );
      remaining = remaining.slice(imageMatch[0].length);
      continue;
    }

    // Bold + italic
    const boldItalicMatch = remaining.match(/^\*\*\*(.+?)\*\*\*/);
    if (boldItalicMatch) {
      parts.push(<strong key={k++} className="font-bold italic">{boldItalicMatch[1]}</strong>);
      remaining = remaining.slice(boldItalicMatch[0].length);
      continue;
    }

    // Bold
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      parts.push(<strong key={k++} className="font-semibold">{boldMatch[1]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic
    const italicMatch = remaining.match(/^\*(.+?)\*/);
    if (italicMatch) {
      parts.push(<em key={k++} className="italic">{italicMatch[1]}</em>);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Link — 链接指向常见图片格式时同样内联预览
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const [, label, url] = linkMatch;
      parts.push(
        isImageUrl(url)
          ? <ChatImage key={`${k++}-${url}`} src={url} alt={label} />
          : <a key={k++} href={url} target="_blank" rel="noopener noreferrer" className="break-all text-[#3550FF] underline decoration-[#3550FF]/30 hover:decoration-[#3550FF]">{label}</a>
      );
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Plain text — consume until next special char, then upgrade bare URLs
    const nextSpecial = remaining.slice(1).search(/[`*[!]/);
    const chunk = nextSpecial === -1 ? remaining : remaining.slice(0, nextSpecial + 1);
    remaining = remaining.slice(chunk.length);
    chunk.split(/(https?:\/\/\S+)/).forEach((piece, idx) => {
      if (!piece) return;
      const pieceKey = `${k++}-${idx}`;
      if (!/^https?:\/\//.test(piece)) {
        parts.push(<span key={pieceKey}>{piece}</span>);
        return;
      }
      const { url, trailing } = splitTrailingPunctuation(piece);
      parts.push(
        isImageUrl(url)
          ? <ChatImage key={`${pieceKey}-${url}`} src={url} />
          : <a key={pieceKey} href={url} target="_blank" rel="noopener noreferrer" className="break-all text-[#3550FF] underline decoration-[#3550FF]/30 hover:decoration-[#3550FF]">{url}</a>
      );
      if (trailing) parts.push(<span key={`${pieceKey}-tail`}>{trailing}</span>);
    });
  }

  return <>{parts}</>;
}

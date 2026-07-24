import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { imageFilename, isImageUrl } from './imageUtils';
import { renderMarkdown } from './markdown';

describe('isImageUrl', () => {
  test('accepts common image extensions required for in-chat preview', () => {
    expect(isImageUrl('https://example.com/a.png')).toBe(true);
    expect(isImageUrl('https://example.com/a.jpg')).toBe(true);
    expect(isImageUrl('https://example.com/a.jpeg')).toBe(true);
    expect(isImageUrl('https://example.com/a.bmp')).toBe(true);
    expect(isImageUrl('https://example.com/a.gif')).toBe(true);
    expect(isImageUrl('https://example.com/a.webp')).toBe(true);
  });

  test('accepts image URLs with query strings or fragments', () => {
    expect(isImageUrl('https://example.com/a.png?w=800&token=abc')).toBe(true);
    expect(isImageUrl('https://example.com/a.JPG#frag')).toBe(true);
  });

  test('rejects non-image URLs and non-http schemes', () => {
    expect(isImageUrl('https://example.com/doc.pdf')).toBe(false);
    expect(isImageUrl('https://example.com/page.html')).toBe(false);
    expect(isImageUrl('ftp://example.com/a.png')).toBe(false);
    expect(isImageUrl('example.com/a.png')).toBe(false);
  });
});

describe('imageFilename', () => {
  test('extracts the file name from the URL path', () => {
    expect(imageFilename('https://example.com/dir/photo.png?x=1')).toBe('photo.png');
  });

  test('falls back to a generic name when the URL has no file name', () => {
    expect(imageFilename('https://example.com/')).toBe('image');
    expect(imageFilename('not a url')).toBe('image');
  });
});

describe('renderMarkdown image preview', () => {
  test('renders markdown image syntax as an inline image', () => {
    const html = renderToStaticMarkup(<>{renderMarkdown('![示意图](https://example.com/a.png)')}</>);
    expect(html).toContain('<img');
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('下载原图');
  });

  test('renders bare image URLs inside text as inline images', () => {
    const html = renderToStaticMarkup(<>{renderMarkdown('看这里 https://example.com/pic.jpeg 已生成')}</>);
    expect(html).toContain('<img');
    expect(html).toContain('src="https://example.com/pic.jpeg"');
    expect(html).toContain('看这里');
  });

  test('renders links pointing at image files as inline images', () => {
    const html = renderToStaticMarkup(<>{renderMarkdown('[扫描结果](https://example.com/x.bmp)')}</>);
    expect(html).toContain('<img');
    expect(html).toContain('src="https://example.com/x.bmp"');
  });

  test('keeps non-image links as plain anchors without images', () => {
    const html = renderToStaticMarkup(<>{renderMarkdown('[文档](https://example.com/doc.pdf)')}</>);
    expect(html).not.toContain('<img');
    expect(html).toContain('<a');
    expect(html).toContain('href="https://example.com/doc.pdf"');
  });

  test('renders bare non-image URLs as clickable anchors', () => {
    const html = renderToStaticMarkup(<>{renderMarkdown('详见 https://example.com/page 了解')}</>);
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://example.com/page"');
  });

  test('keeps trailing punctuation outside the image URL', () => {
    const html = renderToStaticMarkup(<>{renderMarkdown('https://example.com/a.png。')}</>);
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).not.toContain('a.png。');
  });

  test('does not break on partial image syntax while streaming', () => {
    const html = renderToStaticMarkup(<>{renderMarkdown('![alt](https://example.com/a.pn')}</>);
    expect(html).not.toContain('<img');
    expect(html).toContain('[alt](');
    expect(html).toContain('https://example.com/a.pn');
  });

  test('still renders regular markdown around images', () => {
    const html = renderToStaticMarkup(<>{renderMarkdown('# 标题\n\n**加粗** 文本\n\nhttps://example.com/a.png')}</>);
    expect(html).toContain('<strong');
    expect(html).toContain('<img');
  });
});

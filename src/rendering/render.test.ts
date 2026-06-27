import { describe, expect, it } from 'vitest';
import type { CommentNode, CommentTombstone, Post, PostTombstone } from '../domain/types.js';
import {
  renderCommentContent,
  renderContent,
  renderPostContent,
} from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function livePost(content: string): Post {
  return {
    id: 'post-1',
    workspaceId: 'ws-1',
    authorActorId: 'actor-1',
    content,
    createdAt: '2026-06-27T00:00:00.000Z',
    lastActivityAt: '2026-06-27T00:00:00.000Z',
    deletedAt: null,
  };
}

const deletedPost: PostTombstone = {
  id: 'post-1',
  workspaceId: 'ws-1',
  deletedAt: '2026-06-27T00:00:00.000Z',
  isDeleted: true,
};

function liveComment(content: string): CommentNode {
  return {
    id: 'comment-1',
    workspaceId: 'ws-1',
    rootPostId: 'post-1',
    parentId: null,
    authorActorId: 'actor-2',
    content,
    createdAt: '2026-06-27T00:00:00.000Z',
    deletedAt: null,
  };
}

const deletedComment: CommentTombstone = {
  id: 'comment-1',
  rootPostId: 'post-1',
  parentId: null,
  deletedAt: '2026-06-27T00:00:00.000Z',
  isDeleted: true,
};

// Helper: assert no executable script surface survives in rendered HTML.
//
// Escaped text may legitimately contain the literal characters "onerror=" or
// "javascript:" as visible, non-executable bytes (e.g. `&lt;img onerror=...&gt;`).
// So this helper checks the two vectors that actually execute:
//   1. No live dangerous element tag (every user `<` is escaped by the
//      renderer; the only live tags are the fixed set the renderer emits).
//   2. No dangerous scheme inside an emitted `href="..."` attribute.
const DANGEROUS_TAG =
  /<(script|iframe|img|svg|object|embed|style|meta|link|base|form|input|button|video|marquee|details)\b/i;
const DANGEROUS_SCHEME = /(javascript|vbscript|data:text\/html):/i;

function expectNoExecutableScript(html: string): void {
  expect(html).not.toMatch(DANGEROUS_TAG);
  const hrefs = [...html.matchAll(/href="([^"]*)"/gi)].map((m) => m[1] ?? '');
  for (const href of hrefs) {
    expect(href).not.toMatch(DANGEROUS_SCHEME);
  }
}

// ---------------------------------------------------------------------------
// Core sanitization: injected script / unsafe HTML must not execute
// ---------------------------------------------------------------------------

describe('C3a renderContent — script and unsafe HTML injection', () => {
  it('escapes a literal <script> tag so it renders as text, not a live element', () => {
    const html = renderContent('<script>alert(1)</script>');
    expect(html).not.toMatch(/<script[\s>]/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('alert(1)');
  });

  it('escapes an <img onerror> payload', () => {
    const html = renderContent('<img src=x onerror="alert(1)">');
    expectNoExecutableScript(html);
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/<img[\s>]/i);
  });

  it('escapes an <iframe> payload', () => {
    const html = renderContent('<iframe src="javascript:alert(1)"></iframe>');
    expectNoExecutableScript(html);
    expect(html).toContain('&lt;iframe');
  });

  it('drops a javascript: link destination but keeps the link text', () => {
    const html = renderContent('[click me](javascript:alert(1))');
    expectNoExecutableScript(html);
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toContain('click me');
    // No anchor emitted for a rejected destination.
    expect(html).not.toMatch(/<a\s/);
  });

  it('drops a data:text/html link destination', () => {
    const html = renderContent('[x](data:text/html,<script>alert(1)</script>)');
    expectNoExecutableScript(html);
    expect(html).not.toMatch(/<a\s/);
  });

  it('drops a vbscript: link destination', () => {
    const html = renderContent('[x](vbscript:msgbox(1))');
    expectNoExecutableScript(html);
    expect(html).not.toMatch(/<a\s/);
  });

  it('strips control characters that hide a javascript scheme in a link', () => {
    const html = renderContent('[x](java\tscript:alert(1))');
    expectNoExecutableScript(html);
    expect(html).not.toMatch(/<a\s/);
  });

  it('strips a null-byte-hidden javascript scheme in a link', () => {
    const html = renderContent('[x](java\u0000script:alert(1))');
    expectNoExecutableScript(html);
    expect(html).not.toMatch(/<a\s/);
  });

  it('escapes an inline event handler inside a markdown-emphasized span', () => {
    const html = renderContent('**<b onclick=alert(1)>bold**');
    expectNoExecutableScript(html);
    expect(html).toContain('&lt;b');
  });

  it('escapes a raw HTML line treated as a paragraph', () => {
    const html = renderContent('<div>not a real div</div>');
    expect(html).toContain('&lt;div&gt;');
    expect(html).not.toMatch(/<div[\s>]/i);
  });

  it('does not execute script nested inside a fenced code block', () => {
    // Code blocks are escaped verbatim; the script text is visible, not live.
    const html = renderContent('```\n<script>alert(1)</script>\n```');
    expectNoExecutableScript(html);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toMatch(/<pre><code>/);
  });

  it('preserves code-block content as escaped text (C6 builds on this)', () => {
    const html = renderContent('```ts\nconst x = `<b>`;\n```');
    expect(html).toMatch(/<pre><code class="language-ts">/);
    expect(html).toContain('&lt;b&gt;');
  });

  it('rejects a fenced-code language hint that is not a safe class token', () => {
    const html = renderContent('```"><script>alert(1)</script>\nfoo\n```');
    expectNoExecutableScript(html);
    // Unsafe hint dropped: plain <pre><code> with no class attribute injection.
    expect(html).toMatch(/<pre><code>/);
  });
});

// ---------------------------------------------------------------------------
// Safe link handling
// ---------------------------------------------------------------------------

describe('C3a renderContent — safe links', () => {
  it('renders an http link with rel=noopener noreferrer', () => {
    const html = renderContent('[docs](http://example.com/x)');
    expect(html).toContain('<a href="http://example.com/x" rel="noopener noreferrer">docs</a>');
  });

  it('renders an https link', () => {
    const html = renderContent('[docs](https://example.com/x)');
    expect(html).toMatch(/href="https:\/\/example\.com\/x"/);
  });

  it('renders a mailto link', () => {
    const html = renderContent('[mail](mailto:a@b.com)');
    expect(html).toMatch(/href="mailto:a@b\.com"/);
  });

  it('renders a relative URL link', () => {
    const html = renderContent('[home](/path)');
    expect(html).toContain('href="/path"');
  });

  it('renders a fragment link', () => {
    const html = renderContent('[top](#section)');
    expect(html).toContain('href="#section"');
  });

  it('escapes a quote in a link href so it cannot break the attribute', () => {
    const html = renderContent('[x](https://example.com/"onmouseover="alert(1))');
    expectNoExecutableScript(html);
    // The double quote inside the href must be escaped to &quot; so it cannot
    // close the attribute and inject a live onmouseover handler. The literal
    // text "onmouseover" may appear as escaped, non-executable bytes.
    expect(html).toContain('&quot;');
    // No unescaped double-quote appears inside any emitted href attribute.
    const hrefs = [...html.matchAll(/href="([^"]*)"/gi)].map((m) => m[1] ?? '');
    for (const href of hrefs) {
      expect(href).not.toContain('"');
    }
    // No live event-handler attribute is emitted on a renderer tag.
    const liveTagWithHandler =
      /<(?:a|p|code|pre|h[1-6]|ul|ol|li|blockquote|strong|em)\b[^>]*\son\w+\s*=/i;
    expect(html).not.toMatch(liveTagWithHandler);
  });
});

// ---------------------------------------------------------------------------
// Markdown subset rendering (sanitization is the focus; grammar is minimal)
// ---------------------------------------------------------------------------

describe('C3a renderContent — markdown subset', () => {
  it('wraps a plain paragraph in <p>', () => {
    expect(renderContent('hello world')).toBe('<p>hello world</p>');
  });

  it('renders emphasis and strong', () => {
    expect(renderContent('*em*')).toBe('<p><em>em</em></p>');
    expect(renderContent('**strong**')).toBe('<p><strong>strong</strong></p>');
  });

  it('renders inline code as escaped <code>', () => {
    const html = renderContent('use `const <x>`');
    expect(html).toContain('<code>const &lt;x&gt;</code>');
  });

  it('renders an ATX heading', () => {
    const html = renderContent('# Title');
    expect(html).toBe('<h1>Title</h1>');
  });

  it('renders a blockquote', () => {
    const html = renderContent('> quoted');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('quoted');
  });

  it('renders an unordered list', () => {
    const html = renderContent('- a\n- b');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<li>b</li>');
  });

  it('renders an ordered list', () => {
    const html = renderContent('1. a\n2. b');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>a</li>');
  });

  it('renders a hard line break from two trailing spaces', () => {
    const html = renderContent('line one  \nline two');
    expect(html).toContain('<br>');
  });

  it('escapes ampersands and quotes in text', () => {
    expect(renderContent('a & b "c"')).toBe('<p>a &amp; b &quot;c&quot;</p>');
  });
});

// ---------------------------------------------------------------------------
// Surface-specific render paths: post / comment / reply all use sanitization
// ---------------------------------------------------------------------------

describe('C3a renderPostContent — post surface', () => {
  it('renders a live post body through sanitization', () => {
    const result = renderPostContent(livePost('<script>alert(1)</script>safe'));
    expect(result.surface).toBe('post');
    expect(result.isTombstone).toBe(false);
    expectNoExecutableScript(result.html);
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.html).toContain('safe');
  });

  it('renders a tombstone placeholder for a soft-deleted post and never emits content', () => {
    // Even if a tombstone somehow carried content, the type carries none; the
    // placeholder is fixed and content-independent.
    const result = renderPostContent(deletedPost);
    expect(result.isTombstone).toBe(true);
    expect(result.html).toContain('tombstone');
    expect(result.html).not.toMatch(/<script/i);
  });
});

describe('C3a renderCommentContent — comment and reply surfaces', () => {
  it('renders a first-level comment through sanitization', () => {
    const result = renderCommentContent(
      liveComment('<img src=x onerror=alert(1)> hello'),
      'comment',
    );
    expect(result.surface).toBe('comment');
    expect(result.isTombstone).toBe(false);
    expectNoExecutableScript(result.html);
    expect(result.html).toContain('&lt;img');
  });

  it('renders a nested reply through sanitization on the same path', () => {
    const reply: CommentNode = {
      ...liveComment('<script>alert(1)</script> reply'),
      id: 'reply-1',
      parentId: 'comment-1',
    };
    const result = renderCommentContent(reply, 'reply');
    expect(result.surface).toBe('reply');
    expect(result.isTombstone).toBe(false);
    expectNoExecutableScript(result.html);
    expect(result.html).toContain('&lt;script&gt;');
  });

  it('renders a tombstone placeholder for a soft-deleted comment', () => {
    const result = renderCommentContent(deletedComment, 'comment');
    expect(result.isTombstone).toBe(true);
    expect(result.html).toContain('tombstone');
    expect(result.html).not.toMatch(/<script/i);
  });

  it('renders a tombstone placeholder for a soft-deleted reply', () => {
    const deletedReply: CommentTombstone = {
      ...deletedComment,
      id: 'reply-1',
      parentId: 'comment-1',
    };
    const result = renderCommentContent(deletedReply, 'reply');
    expect(result.isTombstone).toBe(true);
    expect(result.surface).toBe('reply');
    expect(result.html).toContain('tombstone');
  });
});

// ---------------------------------------------------------------------------
// Every render path uses sanitization — cross-surface invariant
// ---------------------------------------------------------------------------

describe('C3a — all render paths sanitize', () => {
  const payload = '<script>alert(1)</script><a href="javascript:alert(1)">x</a>';

  it('renderContent sanitizes the raw payload', () => {
    expectNoExecutableScript(renderContent(payload));
  });

  it('renderPostContent sanitizes the raw payload on the post surface', () => {
    expectNoExecutableScript(renderPostContent(livePost(payload)).html);
  });

  it('renderCommentContent sanitizes the raw payload on the comment surface', () => {
    expectNoExecutableScript(renderCommentContent(liveComment(payload), 'comment').html);
  });

  it('renderCommentContent sanitizes the raw payload on the reply surface', () => {
    const reply: CommentNode = { ...liveComment(payload), parentId: 'comment-1' };
    expectNoExecutableScript(renderCommentContent(reply, 'reply').html);
  });

  it('no render path emits raw stored content unescaped', () => {
    // The literal substring "<script>" (unescaped) must never appear in output.
    for (const html of [
      renderContent(payload),
      renderPostContent(livePost(payload)).html,
      renderCommentContent(liveComment(payload), 'comment').html,
      renderCommentContent({ ...liveComment(payload), parentId: 'c' }, 'reply').html,
    ]) {
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<script ');
    }
  });
});

// ---------------------------------------------------------------------------
// Non-string / empty input is handled safely
// ---------------------------------------------------------------------------

describe('C3a renderContent — edge inputs', () => {
  it('renders an empty string to an empty document fragment', () => {
    expect(renderContent('')).toBe('');
  });

  it('renders whitespace-only input to an empty fragment', () => {
    expect(renderContent('   \n\n  ')).toBe('');
  });

  it('handles a payload with only a rejected link and nothing else', () => {
    const html = renderContent('[x](javascript:alert(1))');
    expectNoExecutableScript(html);
    expect(html).toContain('x');
  });
});

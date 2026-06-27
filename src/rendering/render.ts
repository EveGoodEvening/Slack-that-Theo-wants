/**
 * C3a — Safe content rendering baseline.
 *
 * Rendering strategy: a custom Markdown-subset renderer with strict
 * allowlisting. The decision is recorded in `docs/stack-decision.md`
 * (C3a decisions). Rationale summary:
 *
 * - No raw HTML ever passes through. Every text byte is HTML-escaped, so
 *   stored `<script>` / `<img onerror>` / any markup is rendered as visible
 *   text, never as executable HTML.
 * - A tiny, well-defined block + inline grammar is supported (paragraphs,
 *   headings, blockquotes, lists, fenced + inline code, bold, italic, links,
 *   line breaks). Anything outside the grammar is rendered as escaped text.
 * - Link destinations are scheme-allowlisted (`http`, `https`, `mailto`, and
 *   relative `/`, `#`, `?`). `javascript:`, `data:`, `vbscript:`, and all
 *   other schemes are dropped so no attribute can execute script.
 * - No DOM dependency is required (the server runtime is Node, not a
 *   browser), keeping the security surface small and fully auditable.
 *
 * C6 adds syntax highlighting / copy affordances on top of this renderer; it
 * must not bypass `renderContent`. C4/C5 consume `renderPostContent` /
 * `renderCommentContent` and must never render raw stored content.
 */
import {
  type CommentView,
  type PostView,
  isCommentTombstone,
  isPostTombstone,
} from '../domain/types.js';

/**
 * The kind of content surface a render call is for. Used only for telemetry /
 * debugging and to keep the three render paths (post, comment, reply)
 * explicit so C4/C5 cannot accidentally bypass sanitization by interpolating
 * raw strings. Replies and comments share the same body grammar; the
 * discriminator exists so every call site declares which surface it renders.
 */
export type ContentSurface = 'post' | 'comment' | 'reply';

/**
 * Result of rendering a content surface. `html` is safe to insert into an
 * HTML document; it contains no executable script and no unescaped user
 * markup. `isTombstone` is true when the source was a soft-deleted post or
 * comment, in which case `html` is a fixed tombstone placeholder and the
 * original (redacted) content is never rendered.
 */
export interface RenderedContent {
  readonly surface: ContentSurface;
  readonly html: string;
  readonly isTombstone: boolean;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape the five HTML-significant characters. Every user text byte passes here. */
function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Schemes that may appear in a rendered `href`. Relative URLs (`/`, `#`, `?`)
 * are allowed because they cannot carry an executable scheme. Everything else
 * (including `javascript:`, `data:`, `vbscript:`, `file:`, etc.) is rejected.
 */
const ALLOWED_URL_SCHEMES: Record<string, true> = {
  'http:': true,
  'https:': true,
  'mailto:': true,
};

/**
 * Sanitize a link destination. Returns the URL safe to emit in an `href`
 * attribute (still attribute-escaped by the caller), or `null` when the
 * destination is rejected. Control/whitespace characters that can hide a
 * scheme (`\u0000`..`\u001f`, `\u007f`, and Unicode whitespace) are stripped
 * before scheme parsing so `java\tscript:` cannot slip through.
 */
function sanitizeUrl(raw: string): string | null {
  // Strip ASCII control chars and all whitespace (including Unicode) that
  // browsers may ignore when parsing an href. Character codes are used instead
  // of a literal control-range regex to avoid the Biome
  // `noControlCharactersInRegex` lint violation while preserving behavior.
  const stripped = raw
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      // C0 controls (0x00-0x1f), DEL (0x7f), and any whitespace (covers ASCII
      // space/tab/newline and Unicode whitespace via `\s` semantics).
      return !(code <= 0x1f || code === 0x7f || /\s/.test(ch));
    })
    .join('');
  if (stripped === '') {
    return null;
  }
  // Relative URLs: no scheme, no authority. Allow "/", "#", "?" prefixes and
  // plain relative paths that do not start with a scheme.
  if (/^[/?#]/.test(stripped)) {
    return stripped;
  }
  // Anything containing a colon before the first slash/quest/hash is a scheme.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    if (scheme === undefined || !ALLOWED_URL_SCHEMES[`${scheme.toLowerCase()}:`]) {
      return null;
    }
    return stripped;
  }
  // No scheme and not a relative URL — treat as a relative path (safe).
  return stripped;
}

/** Restrict a fenced-code language hint to a safe charset for a CSS class. */
function safeLanguageHint(raw: string): string | null {
  const match = /^([a-zA-Z0-9_-]+)$/.exec(raw.trim());
  return match ? (match[1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

/**
 * Render inline Markdown to safe HTML. Supported inline syntax:
 * - `` `code` `` → escaped `<code>`
 * - `**strong**` and `__strong__` → `<strong>`
 * - `*em*` and `_em_` → `<em>`
 * - `[text](href)` → `<a href="sanitized">escaped text</a>` (rejected hrefs
 *   render as escaped text without an anchor)
 * - hard line breaks: two trailing spaces + `\n`, or a backslash before `\n`
 * - soft line breaks: a lone `\n` → space (block-level `<br>` is added by the
 *   block parser for paragraph-internal newlines when desired)
 *
 * Everything else is emitted as escaped text. The parser is a single
 * left-to-right scan with no recursion into untrusted input.
 */
function renderInline(text: string): string {
  let out = '';
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i] as string;

    // Inline code span: `...` (longest matching backtick run as fence).
    if (ch === '`') {
      let fenceLen = 0;
      while (i + fenceLen < len && text[i + fenceLen] === '`') {
        fenceLen++;
      }
      const close = findCodeSpanClose(text, i + fenceLen, fenceLen);
      if (close !== -1) {
        const code = text.slice(i + fenceLen, close);
        // Trim one leading/trailing space when present (CommonMark nicety).
        const trimmed =
          code.length > 0 && code[0] === ' ' && code[code.length - 1] === ' '
            ? code.slice(1, -1)
            : code;
        out += `<code>${escapeHtml(trimmed)}</code>`;
        i = close + fenceLen;
        continue;
      }
    }

    // Strong: **...** or __...__
    if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const close = findDelimClose(text, i + 2, ch, 2);
      if (close !== -1) {
        const inner = text.slice(i + 2, close);
        out += `<strong>${renderInline(inner)}</strong>`;
        i = close + 2;
        continue;
      }
    }

    // Emphasis: *...* or _..._ (single delimiter, not part of strong).
    if (ch === '*' || ch === '_') {
      const close = findDelimClose(text, i + 1, ch, 1);
      if (close !== -1) {
        const inner = text.slice(i + 1, close);
        out += `<em>${renderInline(inner)}</em>`;
        i = close + 1;
        continue;
      }
    }

    // Link: [text](href)
    if (ch === '[') {
      const textClose = findUnescaped(text, i + 1, ']');
      if (textClose !== -1 && text[textClose + 1] === '(') {
        const hrefClose = findUnescaped(text, textClose + 2, ')');
        if (hrefClose !== -1) {
          const linkText = text.slice(i + 1, textClose);
          const rawHref = text.slice(textClose + 2, hrefClose);
          const href = sanitizeUrl(rawHref);
          if (href === null) {
            // Rejected destination: render the text only, no anchor.
            out += renderInline(linkText);
          } else {
            out += `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${renderInline(
              linkText,
            )}</a>`;
          }
          i = hrefClose + 1;
          continue;
        }
      }
    }

    // Hard line break: backslash + newline, or two trailing spaces + newline.
    if (ch === '\\' && text[i + 1] === '\n') {
      out += '<br>';
      i += 2;
      continue;
    }
    if (ch === '\n') {
      // Soft break within a block becomes a space; block parser owns <p>.
      out += ' ';
      i += 1;
      continue;
    }

    // Backslash escape: emit the next char as literal escaped text.
    if (ch === '\\' && i + 1 < len) {
      out += escapeHtml(text[i + 1] as string);
      i += 2;
      continue;
    }

    // Default: escape and emit one character. This is the path that makes
    // raw HTML safe — `<`, `>`, `&`, quotes all become entities here.
    out += escapeHtml(ch);
    i += 1;
  }

  return out;
}

/** Find the closing backtick fence of the same length starting at `from`. */
function findCodeSpanClose(text: string, from: number, fenceLen: number): number {
  const len = text.length;
  for (let i = from; i <= len - fenceLen; i++) {
    let matched = true;
    for (let k = 0; k < fenceLen; k++) {
      if (text[i + k] !== '`') {
        matched = false;
        break;
      }
    }
    if (matched) {
      return i;
    }
  }
  return -1;
}

/** Find the closing run of `delim` of length `runLen`, ignoring escaped delims. */
function findDelimClose(
  text: string,
  from: number,
  delim: string,
  runLen: number,
): number {
  const len = text.length;
  for (let i = from; i <= len - runLen; i++) {
    if (text[i] === '\\') {
      i += 1; // skip escaped char
      continue;
    }
    let matched = true;
    for (let k = 0; k < runLen; k++) {
      if (text[i + k] !== delim) {
        matched = false;
        break;
      }
    }
    if (matched) {
      // For single-delimiter emphasis, do not match if a longer run starts
      // here (that is strong's job).
      if (runLen === 1 && text[i + 1] === delim) {
        i += 1;
        continue;
      }
      return i;
    }
  }
  return -1;
}

/** Find the next occurrence of `ch` not preceded by a backslash, or -1. */
function findUnescaped(text: string, from: number, ch: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === ch) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

/**
 * Render a block of Markdown source to safe HTML. Block grammar:
 * - Fenced code blocks ``` lang / ~~~
 * - ATX headings (# .. ######)
 * - Blockquotes (> ...)
 * - Unordered lists (- / * / +)
 * - Ordered lists (1. / 1)
 * - Blank lines separate paragraphs
 * - Everything else is a paragraph
 *
 * Raw HTML lines (starting with `<`) are treated as paragraph text and
 * escaped by `renderInline`; they never become live elements.
 */
function renderBlocks(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    // Blank line.
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Fenced code block.
    const fence = matchFence(line);
    if (fence) {
      const { marker, lang } = fence;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const cur = lines[i] as string;
        if (isFenceClose(cur, marker)) {
          i += 1;
          break;
        }
        codeLines.push(cur);
        i += 1;
      }
      out.push(renderCodeBlock(codeLines.join('\n'), lang));
      continue;
    }

    // ATX heading.
    const heading = matchHeading(line);
    if (heading) {
      out.push(`<h${heading.level}>${renderInline(heading.text.trim())}</h${heading.level}>`);
      i += 1;
      continue;
    }

    // Blockquote (consecutive `>` lines).
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] as string)) {
        quoteLines.push((lines[i] as string).replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(quoteLines.join('\n'))}</blockquote>`);
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] as string)) {
        items.push((lines[i] as string).replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      out.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] as string)) {
        items.push((lines[i] as string).replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      out.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ol>`);
      continue;
    }

    // Paragraph: consume until blank line or a block starter. Render each
    // line through renderInline, then join: a line ending in two trailing
    // spaces is a hard break (<br>); otherwise a soft break (space). The
    // <br> is inserted between already-rendered fragments so it is never
    // passed through escapeHtml.
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] as string).trim() !== '' &&
      !matchFence(lines[i] as string) &&
      !matchHeading(lines[i] as string) &&
      !/^>\s?/.test(lines[i] as string) &&
      !/^\s*[-*+]\s+/.test(lines[i] as string) &&
      !/^\s*\d+[.)]\s+/.test(lines[i] as string)
    ) {
      paraLines.push(lines[i] as string);
      i += 1;
    }
    const fragments = paraLines.map((ln) => {
      const hardBreak = / {2}$/.test(ln);
      const rendered = renderInline(ln.replace(/ {2}$/, ''));
      return { rendered, hardBreak };
    });
    let paraHtml = '';
    for (let k = 0; k < fragments.length; k++) {
      const frag = fragments[k] as { rendered: string; hardBreak: boolean };
      paraHtml += frag.rendered;
      if (k < fragments.length - 1) {
        paraHtml += frag.hardBreak ? '<br>' : ' ';
      }
    }
    out.push(`<p>${paraHtml}</p>`);
  }

  return out.join('\n');
}

interface FenceMatch {
  marker: string;
  lang: string;
}

function matchFence(line: string): FenceMatch | null {
  const match = /^(\s*)(```+|~~~+)/.exec(line);
  if (!match) {
    return null;
  }
  const marker = match[2] as string;
  const lang = line.slice((match[1] ?? '').length + marker.length).trim();
  return { marker, lang };
}

function isFenceClose(line: string, marker: string): boolean {
  const trimmed = line.trim();
  const ch = marker[0] as string;
  if (trimmed[0] !== ch) {
    return false;
  }
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== ch) {
      return false;
    }
  }
  return trimmed.length >= marker.length;
}

function matchHeading(line: string): { level: number; text: string } | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  return { level: (match[1] ?? '').length, text: match[2] ?? '' };
}

function renderCodeBlock(code: string, lang: string): string {
  const escaped = escapeHtml(code);
  const hint = safeLanguageHint(lang);
  if (hint) {
    return `<pre><code class="language-${hint}">${escaped}</code></pre>`;
  }
  return `<pre><code>${escaped}</code></pre>`;
}

// ---------------------------------------------------------------------------
// Public render API
// ---------------------------------------------------------------------------

/**
 * Render a raw content string to safe HTML. This is the single sanitizing
 * entry point. C4/C5 must call this (or the surface-specific helpers below)
 * for every user-content surface and must never interpolate stored content
 * directly into HTML.
 *
 * The input is treated as untrusted Markdown-subset source. All raw HTML is
 * escaped; unsafe link schemes are dropped. The output is safe to insert into
 * an HTML document body.
 */
export function renderContent(content: string): string {
  // Collapse trailing newlines only; preserve internal structure. Guard
  // against non-string input defensively (callers should pass strings).
  const source = typeof content === 'string' ? content.replace(/\n+$/g, '') : '';
  return renderBlocks(source);
}

/**
 * Render a post surface. Accepts a live `Post` or a `PostTombstone`; when the
 * post is soft-deleted, a fixed tombstone placeholder is returned and the
 * (redacted) content is never rendered. C4 must route every post body through
 * this function.
 */
export function renderPostContent(post: PostView): RenderedContent {
  if (isPostTombstone(post)) {
    return { surface: 'post', html: TOMBSTONE_HTML.post, isTombstone: true };
  }
  return { surface: 'post', html: renderContent(post.content), isTombstone: false };
}

/**
 * Render a comment or reply surface. Accepts a live `CommentNode` or a
 * `CommentTombstone`; when the node is soft-deleted, a fixed tombstone
 * placeholder is returned. C5 must route every first-level comment and every
 * nested reply through this function — replies are comments at depth, so one
 * function covers both surfaces and the `surface` discriminator records which.
 */
export function renderCommentContent(
  node: CommentView,
  surface: Extract<ContentSurface, 'comment' | 'reply'>,
): RenderedContent {
  if (isCommentTombstone(node)) {
    return { surface, html: TOMBSTONE_HTML.comment, isTombstone: true };
  }
  return { surface, html: renderContent(node.content), isTombstone: false };
}

/** Fixed tombstone placeholders per surface; content is never referenced. */
const TOMBSTONE_HTML: Record<'post' | 'comment', string> = {
  post: '<p class="tombstone">This post was deleted.</p>',
  comment: '<p class="tombstone">This comment was deleted.</p>',
};

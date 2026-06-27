/**
 * C6 — Dependency-free, safe syntax highlighting for fenced code blocks.
 *
 * Design constraints (see `docs/stack-decision.md`, C3a/C6 decisions):
 * - No external highlighting dependency. A library (highlight.js/Shiki) would
 *   add a large audit/security surface and break the project's thin-layers /
 *   no-unnecessary-deps philosophy. The server runtime is Node, not a browser.
 * - The highlighter never introduces live HTML. It tokenizes the **raw** code
 *   into typed spans, then each token's text is HTML-escaped by the caller and
 *   wrapped in `<span class="tok-X">…</span>`. The only new live tag is `span`
 *   with a class from a fixed allowlist; no attributes, no event handlers, no
 *   raw markup ever passes through.
 * - Tokenization is a single left-to-right scan with no recursion into
 *   untrusted input, mirroring the C3a inline parser's safety shape.
 * - Coverage is deliberately small (comments, strings, numbers, keywords,
 *   booleans) for a few common languages (ts/js/jsx/tsx). Anything unmatched
 *   is emitted as plain escaped text, so formatting is always preserved even
 *   when a language is unrecognized — the generic fallback still renders the
 *   code verbatim inside `<pre><code>`.
 */

/**
 * A typed token produced by the highlighter. `kind` is one of the fixed
 * `TOKEN_KINDS`; `text` is the raw (unescaped) source slice. The caller escapes
 * `text` and wraps it in `<span class="tok-{kind}">`.
 */
export interface HighlightToken {
  readonly kind: TokenKind;
  readonly text: string;
}

/** The fixed set of token kinds the highlighter may emit. */
export const TOKEN_KINDS = [
  'comment',
  'string',
  'number',
  'keyword',
  'literal',
  'punct',
  'plain',
] as const;

export type TokenKind = (typeof TOKEN_KINDS)[number];

/** Set of class tokens the renderer is allowed to emit, for fast lookup. */
const TOKEN_KIND_SET: ReadonlySet<string> = new Set(TOKEN_KINDS);

/** True when `kind` is one of the fixed token kinds. */
export function isTokenKind(kind: string): boolean {
  return TOKEN_KIND_SET.has(kind);
}

/**
 * Keywords shared by TypeScript and JavaScript. Intentionally a small,
 * well-known set; unknown identifiers stay `plain` so formatting is preserved.
 */
const TS_KEYWORDS: Record<string, true> = {
  abstract: true, as: true, asserts: true, async: true, await: true,
  break: true, case: true, catch: true, class: true, const: true,
  continue: true, debugger: true, declare: true, default: true, delete: true,
  do: true, else: true, enum: true, export: true, extends: true,
  finally: true, for: true, from: true, function: true, get: true,
  if: true, implements: true, import: true, in: true, infer: true,
  instanceof: true, interface: true, is: true, keyof: true, let: true,
  namespace: true, new: true, of: true, private: true, protected: true,
  public: true, readonly: true, return: true, satisfies: true, set: true,
  static: true, super: true, switch: true, this: true, throw: true,
  try: true, type: true, typeof: true, void: true, while: true,
  with: true, yield: true,
};

const LITERALS: Record<string, true> = {
  true: true, false: true, null: true, undefined: true,
};

/**
 * Language aliases that resolve to the TypeScript/JavaScript tokenizer. The
 * fenced-code language hint is restricted by `safeLanguageHint` to
 * `[a-zA-Z0-9_-]+`, so these names are the only ones that can reach here with
 * a matching alias. Unknown languages fall back to `highlightGeneric`.
 */
const TS_ALIASES: Record<string, true> = {
  ts: true, tsx: true, typescript: true,
  js: true, jsx: true, javascript: true, mjs: true, cjs: true,
};

/** True when `lang` (already safe-class-tokenized) maps to the TS/JS tokenizer. */
export function isTsLike(lang: string): boolean {
  return TS_ALIASES[lang.toLowerCase()] === true;
}

/**
 * Tokenize raw source code for a given language hint into typed tokens. The
 * output is intended to be escaped-and-wrapped by the caller; this function
 * never produces HTML. Unknown languages yield a single `plain` token so the
 * caller still renders the code verbatim with formatting intact.
 */
export function tokenize(code: string, lang: string): HighlightToken[] {
  if (isTsLike(lang)) {
    return tokenizeTs(code);
  }
  return [{ kind: 'plain', text: code }];
}

/**
 * Generic fallback: a single `plain` token covering the whole block. The
 * caller still escapes it and wraps it in `<pre><code>`, so formatting is
 * preserved and the content remains sanitized. Exported for direct use by the
 * renderer when no language hint is present.
 */
export function highlightGeneric(code: string): HighlightToken[] {
  return [{ kind: 'plain', text: code }];
}

/**
 * TypeScript/JavaScript tokenizer. A single left-to-right scan recognizing:
 * - line comments `// …` and block comments `/* … *\/`
 * - strings: `"…"` `'…'` template `` `…` `` (with `${…}` left as plain)
 * - numbers (integer, decimal, hex, binary, octal, with optional exponent)
 * - identifiers (keyword / literal / plain)
 * - punctuation (single char → `punct`)
 * - everything else → one-char `plain`
 *
 * The scan never recurses into untrusted input and never emits raw HTML.
 */
function tokenizeTs(code: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const len = code.length;
  let i = 0;

  while (i < len) {
    const ch = code[i] as string;
    const next = i + 1 < len ? (code[i + 1] as string) : '';

    // Line comment.
    if (ch === '/' && next === '/') {
      let end = i + 2;
      while (end < len && code[end] !== '\n') {
        end += 1;
      }
      tokens.push({ kind: 'comment', text: code.slice(i, end) });
      i = end;
      continue;
    }

    // Block comment. Treat an unterminated block comment as running to EOF
    // (safe: it is still escaped as a comment token, never live HTML).
    if (ch === '/' && next === '*') {
      let end = i + 2;
      while (end < len && !(code[end] === '*' && code[end + 1] === '/')) {
        end += 1;
      }
      const close = end < len ? end + 2 : len;
      tokens.push({ kind: 'comment', text: code.slice(i, close) });
      i = close;
      continue;
    }

    // String literals: double, single, or template (backtick).
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let end = i + 1;
      while (end < len) {
        const c = code[end] as string;
        if (c === '\\') {
          end += 2; // skip escaped char
          continue;
        }
        if (c === quote) {
          end += 1;
          break;
        }
        // Template strings may span newlines; other strings terminate at a
        // raw newline (unterminated literal → run to end of line, still safe).
        if (quote !== '`' && c === '\n') {
          break;
        }
        end += 1;
      }
      tokens.push({ kind: 'string', text: code.slice(i, end) });
      i = end;
      continue;
    }

    // Numbers: 0x.., 0b.., 0o.., decimal with optional fraction/exponent.
    if (isDigit(ch) || (ch === '.' && isDigit(next))) {
      let end = i;
      if (ch === '0' && (next === 'x' || next === 'X')) {
        end = i + 2;
        while (end < len && isHexDigit(code[end] as string)) {
          end += 1;
        }
      } else if (ch === '0' && (next === 'b' || next === 'B')) {
        end = i + 2;
        while (end < len && (code[end] === '0' || code[end] === '1')) {
          end += 1;
        }
      } else if (ch === '0' && (next === 'o' || next === 'O')) {
        end = i + 2;
        while (end < len && isOctalDigit(code[end] as string)) {
          end += 1;
        }
      } else {
        while (end < len && isDigit(code[end] as string)) {
          end += 1;
        }
        if (end < len && code[end] === '.') {
          end += 1;
          while (end < len && isDigit(code[end] as string)) {
            end += 1;
          }
        }
        if (end < len && (code[end] === 'e' || code[end] === 'E')) {
          let e = end + 1;
          if (e < len && (code[e] === '+' || code[e] === '-')) {
            e += 1;
          }
          if (e < len && isDigit(code[e] as string)) {
            end = e;
            while (end < len && isDigit(code[end] as string)) {
              end += 1;
            }
          }
        }
      }
      // A trailing identifier char (e.g. `123n` bigint) is part of the number.
      while (end < len && isIdentPart(code[end] as string)) {
        end += 1;
      }
      tokens.push({ kind: 'number', text: code.slice(i, end) });
      i = end;
      continue;
    }

    // Identifiers / keywords / literals.
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < len && isIdentPart(code[end] as string)) {
        end += 1;
      }
      const word = code.slice(i, end);
      let kind: TokenKind = 'plain';
      if (LITERALS[word] === true) {
        kind = 'literal';
      } else if (TS_KEYWORDS[word] === true) {
        kind = 'keyword';
      }
      tokens.push({ kind, text: word });
      i = end;
      continue;
    }

    // Punctuation: a single-char punct token for common operators/brackets.
    if (isPunct(ch)) {
      tokens.push({ kind: 'punct', text: ch });
      i += 1;
      continue;
    }

    // Default: one-char plain (whitespace, newlines, any other byte). Newlines
    // are preserved here so the caller's `<pre>` keeps the original formatting.
    tokens.push({ kind: 'plain', text: ch });
    i += 1;
  }

  return tokens;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}
function isOctalDigit(ch: string): boolean {
  return ch >= '0' && ch <= '7';
}
function isIdentStart(ch: string): boolean {
  return ch === '_' || ch === '$' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}
function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}
function isPunct(ch: string): boolean {
  return '[](){}.,;:<>+-*/%=!&|^~?:@'.includes(ch);
}

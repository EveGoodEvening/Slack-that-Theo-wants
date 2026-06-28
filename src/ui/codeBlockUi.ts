/**
 * C6 — Shared UI assets for code blocks: styling for highlighted code + the
 * copy affordance, the copy-button progressive-enhancement script, and the
 * composer preview toggle script.
 *
 * These are static strings interpolated into the server-rendered documents
 * emitted by C4 (`feed.ts`) and C5 (`postDetail.ts`). They contain no user
 * content and no template interpolation, so they are safe to emit verbatim.
 *
 * - The copy script reads `code.textContent` from the DOM. The browser
 *   unescapes HTML entities when reading `textContent`, so the clipboard
 *   receives the original code bytes without any user content being duplicated
 *   into an attribute. Without JS the code is still fully visible and
 *   selectable, so the affordance degrades gracefully.
 * - The preview script POSTs the composer's raw text (plus the hidden
 *   `actorId` / `workspaceId` fields from the same form) to
 *   `POST /feed/preview` and inserts the server-rendered (C3a-sanitized) HTML
 *   into a preview pane. The preview is always produced by the same sanitizing
 *   renderer as live content, so it can never introduce unsanitized markup.
 */

/** CSS for fenced code blocks, highlight tokens, and the copy button. */
export const CODE_BLOCK_CSS = `
    .code-block { position: relative; margin: 1rem 0; }
    .code-block pre { margin: 0; padding: 0.75rem 1rem; overflow-x: auto; background: #f6f8fa; border: 1px solid #e1e1e1; border-radius: 6px; }
    .code-block code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9rem; line-height: 1.4; white-space: pre; }
    .code-block .copy-code { position: absolute; top: 0.35rem; right: 0.45rem; font-size: 0.75rem; padding: 0.15rem 0.5rem; border: 1px solid #d0d7de; border-radius: 4px; background: #fff; cursor: pointer; }
    .code-block .copy-code[aria-pressed="true"] { background: #ddf4ff; }
    .tok-comment { color: #6a737d; font-style: italic; }
    .tok-string { color: #0a7d28; }
    .tok-number { color: #b35900; }
    .tok-keyword { color: #b2089a; }
    .tok-literal { color: #b35900; }
    .tok-punct { color: #555; }
    .composer-preview { margin-top: 0.5rem; border: 1px dashed #d0d7de; border-radius: 6px; padding: 0.5rem 0.75rem; min-height: 1rem; }
    .composer-preview:empty { display: none; }
    .composer-preview .preview-label { display: block; font-size: 0.75rem; color: #6a737d; margin-bottom: 0.25rem; }
    .preview-toggle { margin-top: 0.5rem; font-size: 0.85rem; background: none; border: none; color: #0969da; cursor: pointer; padding: 0; }`;

/**
 * Progressive-enhancement script for the copy-code affordance. Delegates clicks
 * from `document` so code blocks injected later by composer previews use the
 * same handler as static server-rendered blocks. Reads
 * `code.textContent` (browser-unescaped) and writes it to the clipboard via
 * `navigator.clipboard`, with the existing textarea fallback for older browsers.
 */
export const COPY_CODE_SCRIPT = `
    (function () {
      function copyText(text, done, fail) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, fail);
          return;
        }
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { fail(); }
        document.body.removeChild(ta);
      }
      document.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var btn = target.closest('.copy-code');
        if (!btn) return;
        var figure = btn.closest('.code-block');
        if (!figure) return;
        var code = figure.querySelector('code');
        if (!code) return;
        copyText(code.textContent || '', function () {
          btn.setAttribute('aria-pressed', 'true');
          btn.textContent = 'Copied';
          setTimeout(function () {
            btn.removeAttribute('aria-pressed');
            btn.textContent = 'Copy';
          }, 1500);
        }, function () {
          btn.textContent = 'Copy failed';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
        });
      });
    })();`;

/**
 * Progressive-enhancement script for the composer preview toggle. Delegates
 * clicks from preview toggle buttons with `data-preview-for="<textareaId>"` so
 * controls inserted after initial page load (for example, realtime-swapped
 * post-detail conversation fragments) use the same handler as server-rendered
 * controls. The handler POSTs the textarea's raw value (plus the hidden
 * `actorId` / `workspaceId` fields from the same composer form) to
 * `POST /feed/preview` and renders the returned (sanitized) HTML into the
 * matching `.composer-preview` pane. The preview endpoint reuses the C3a
 * renderer and resolves the same C1a principal as live mutations, so previewed
 * content is sanitized identically to live content and the surface stays behind
 * the authorization baseline.
 */
export const PREVIEW_SCRIPT = `
    (function () {
      document.addEventListener('click', function (event) {
        var target = event.target;
        var toggle = target && target.closest ? target.closest('.preview-toggle[data-preview-for]') : null;
        if (!toggle) return;
        var targetId = toggle.getAttribute('data-preview-for');
        if (!targetId) return;
        var textarea = document.getElementById(targetId);
        var pane = document.querySelector('.composer-preview[data-preview-for="' + targetId + '"]');
        if (!textarea || !pane) return;
        var body = new URLSearchParams();
        body.set('content', textarea.value || '');
        var form = toggle.closest('form');
        if (form) {
          var actor = form.querySelector('input[name="actorId"]');
          var ws = form.querySelector('input[name="workspaceId"]');
          if (actor && actor.value) body.set('actorId', actor.value);
          if (ws && ws.value) body.set('workspaceId', ws.value);
        }
        pane.innerHTML = '<span class="preview-label">Preview…</span>';
        fetch('/feed/preview', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
          .then(function (r) { return r.text(); })
          .then(function (html) {
            pane.innerHTML = '<span class="preview-label">Preview</span>' + html;
          })
          .catch(function () {
            pane.innerHTML = '<span class="preview-label">Preview unavailable</span>';
          });
      });
    })();`;

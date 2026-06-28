import { Hono } from 'hono';
import {
  AuthenticationError,
  type AuthRepository,
  clearSessionCookie,
  sessionCookie,
  sessionSecretFromRequest,
} from '../security/auth.js';
import { escapeText } from '../ui/shared.js';

/** C9 local sign-in/sign-out routes. */
export interface AuthRouteDeps {
  auth: AuthRepository;
}

export function authRoutes(deps: AuthRouteDeps): Hono {
  const route = new Hono();

  route.get('/signin', (c) => {
    return c.html(renderSignInDocument());
  });

  route.post('/signin', async (c) => {
    const form = await c.req.formData().catch(() => null);
    const email = form?.get('email');
    const password = form?.get('password');
    const workspaceId = form?.get('workspaceId');

    if (typeof email !== 'string' || email.trim().length === 0) {
      return c.html(renderSignInDocument('email is required'), 400);
    }
    if (typeof password !== 'string' || password.length === 0) {
      return c.html(renderSignInDocument('password is required'), 400);
    }

    try {
      const request: {
        email: string;
        password: string;
        workspaceId?: string;
      } = { email, password };
      if (typeof workspaceId === 'string' && workspaceId.trim().length > 0) {
        request.workspaceId = workspaceId.trim();
      }
      const session = deps.auth.authenticate(request);
      const target = '/feed';
      return new Response(null, {
        status: 303,
        headers: {
          location: target,
          'set-cookie': sessionCookie(session.secret, session.expiresAt),
        },
      });
    } catch (err) {
      if (err instanceof AuthenticationError) {
        return c.html(renderSignInDocument(err.message), 401);
      }
      throw err;
    }
  });

  route.post('/signout', (c) => {
    const secret = sessionSecretFromRequest(c.req);
    if (secret !== undefined) {
      deps.auth.revokeSession(secret);
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: '/auth/signin',
        'set-cookie': clearSessionCookie(),
      },
    });
  });

  return route;
}

function renderSignInDocument(error?: string): string {
  const errorBlock =
    error === undefined
      ? ''
      : `  <p class="auth-error" role="alert">${escapeText(error)}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in — Slack that Theo wants</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 420px; margin: 3rem auto; padding: 0 1rem; color: #111; }
    label { display: block; margin: 0.75rem 0 0.25rem; }
    input { width: 100%; box-sizing: border-box; padding: 0.5rem; font: inherit; }
    button { margin-top: 1rem; }
    .auth-error { color: #b00; }
  </style>
</head>
<body>
  <h1>Sign in</h1>
${errorBlock}
  <form method="post" action="/auth/signin">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    <label for="workspaceId">Workspace/group (optional)</label>
    <input id="workspaceId" name="workspaceId" autocomplete="off" />
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

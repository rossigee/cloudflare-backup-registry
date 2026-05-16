import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './durable-object';

export interface AuthConfig {
  basic: { username: string; password: string } | null;
  jwtIssuer: string | null;
  jwtAudience: string | null;
  jwksUri: string | null;
  apiTokens: string[];
  oauth2: {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string | null;
  } | null;
}

export function getAuthConfig(env: Env): AuthConfig {
  const basic =
    env.AUTH_USER && env.AUTH_PASS
      ? { username: env.AUTH_USER, password: env.AUTH_PASS }
      : null;

  const apiTokens = env.API_TOKENS
    ? env.API_TOKENS.split(',').map(t => t.trim()).filter(Boolean)
    : [];

  let oauth2: AuthConfig['oauth2'] = null;
  if (env.JWT_ISSUER && env.KEYCLOAK_CLIENT_SECRET) {
    const issuer = env.JWT_ISSUER;
    oauth2 = {
      authorizationEndpoint: `${issuer}/protocol/openid-connect/auth`,
      tokenEndpoint: `${issuer}/protocol/openid-connect/token`,
      clientId: env.JWT_AUDIENCE || 'backups-registry',
      clientSecret: env.KEYCLOAK_CLIENT_SECRET,
      redirectUri: env.BASE_URL ? `${env.BASE_URL}/oauth/callback` : null,
    };
  }

  return {
    basic,
    jwtIssuer: env.JWT_ISSUER || null,
    jwtAudience: env.JWT_AUDIENCE || null,
    jwksUri: env.JWKS_URI || null,
    apiTokens,
    oauth2,
  };
}

function isConfigured(config: AuthConfig): boolean {
  return config.basic !== null || config.jwtIssuer !== null || config.apiTokens.length > 0;
}

let cachedJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJWKSUri: string | null = null;

function getJWKS(uri: string): ReturnType<typeof createRemoteJWKSet> {
  if (!cachedJWKS || cachedJWKSUri !== uri) {
    cachedJWKS = createRemoteJWKSet(new URL(uri));
    cachedJWKSUri = uri;
  }
  return cachedJWKS;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const maxLen = Math.max(a.length, b.length);
  const ab = enc.encode(a.padEnd(maxLen));
  const bb = enc.encode(b.padEnd(maxLen));
  let diff = a.length ^ b.length;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

async function validateJWT(token: string, config: AuthConfig): Promise<boolean> {
  if (!config.jwtIssuer) {
    console.error('JWT issuer not configured');
    return false;
  }

  const jwksUri = config.jwksUri || `${config.jwtIssuer}/.well-known/jwks.json`;
  console.log('Validating JWT with issuer:', config.jwtIssuer, 'audience:', config.jwtAudience, 'jwks:', jwksUri);
  const JWKS = getJWKS(jwksUri);

  try {
    const result = await jwtVerify(token, JWKS, {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience || undefined,
    });
    console.log('JWT validation successful:', result);
    return true;
  } catch (e) {
    console.error('JWT validation error:', e);
    return false;
  }
}

function validateApiToken(token: string, config: AuthConfig): boolean {
  let valid = false;
  for (const t of config.apiTokens) {
    if (timingSafeEqual(token, t)) valid = true;
  }
  return valid;
}

function validateBasicAuth(headerValue: string, config: AuthConfig): boolean {
  if (!config.basic) return false;
  const [scheme, encoded] = headerValue.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = atob(encoded);
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) return false;
  const username = decoded.substring(0, colonIdx);
  const password = decoded.substring(colonIdx + 1);
  return timingSafeEqual(username, config.basic.username) && timingSafeEqual(password, config.basic.password);
}

export async function authenticate(request: Request, env: Env, config?: AuthConfig): Promise<{ authenticated: boolean; redirect?: string }> {
  const cfg = config ?? getAuthConfig(env);
  if (!isConfigured(cfg)) return { authenticated: true };

  const url = new URL(request.url);
  if (url.hostname === 'localhost') return { authenticated: true };

  const sessionCookie = request.headers.get('Cookie')?.match(/backup_registry_session=([^;]+)/)?.[1];
  if (sessionCookie) {
    try {
      const token = atob(sessionCookie);
      console.log('Session cookie found, token starts with:', token.substring(0, 50));
      console.log('JWT config - issuer:', cfg.jwtIssuer, 'audience:', cfg.jwtAudience, 'jwks:', cfg.jwksUri);
      if (await validateJWT(token, cfg)) return { authenticated: true };
      console.error('Session JWT validation failed');
    } catch (e) {
      console.error('Session cookie parse error:', e);
    }
  }

  const authHeader = request.headers.get('Authorization');

  if (authHeader) {
    if (authHeader.startsWith('Basic ')) {
      const valid = validateBasicAuth(authHeader, cfg);
      return { authenticated: valid };
    }
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (await validateJWT(token, cfg)) return { authenticated: true };
      if (validateApiToken(token, cfg)) return { authenticated: true };
      return { authenticated: false };
    }
    return { authenticated: false };
  }

  const apiKeyHeader = request.headers.get('X-API-Key');
  if (apiKeyHeader && validateApiToken(apiKeyHeader, cfg)) return { authenticated: true };

  if (cfg.oauth2 && request.headers.get('Accept')?.includes('text/html')) {
    const state = btoa(url.pathname + url.search);
    const redirectUri = cfg.oauth2.redirectUri || `${url.origin}/oauth/callback`;
    const authUrl = new URL(cfg.oauth2.authorizationEndpoint);
    authUrl.searchParams.set('client_id', cfg.oauth2.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('scope', 'openid');
    console.log('Redirecting to OAuth provider:', authUrl.toString());
    return { authenticated: false, redirect: authUrl.toString() };
  }

  return { authenticated: false };
}

export function unauthorized(config: AuthConfig, redirectUrl?: string): Response {
  if (redirectUrl) {
    return Response.redirect(redirectUrl, 302);
  }
  const schemes: string[] = [];
  if (config.basic) schemes.push('Basic realm="backup-registry"');
  if (config.jwtIssuer || config.apiTokens.length > 0) schemes.push('Bearer realm="backup-registry"');
  if (schemes.length === 0) schemes.push('Basic realm="backup-registry"');
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': schemes.join(', ') },
  });
}

export function createSessionCookie(token: string, path: string = '/'): Response {
  const encoded = btoa(token);
  return new Response(null, {
    status: 302,
    headers: {
      'Location': path,
      'Set-Cookie': `backup_registry_session=${encoded}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
    },
  });
}

export function clearSessionCookie(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': `backup_registry_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    },
  });
}

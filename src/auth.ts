import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './durable-object';

export interface AuthConfig {
  basic: { username: string; password: string } | null;
  jwtIssuer: string | null;
  jwtAudience: string | null;
  jwksUri: string | null;
  apiTokens: Set<string>;
  oauth2: {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  } | null;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export function getAuthConfig(env: Env): AuthConfig {
  const basic =
    env.AUTH_USER && env.AUTH_PASS
      ? { username: env.AUTH_USER, password: env.AUTH_PASS }
      : null;

  const apiTokens = env.API_TOKENS
    ? new Set(env.API_TOKENS.split(',').map(t => t.trim()).filter(Boolean))
    : new Set<string>();

  let oauth2: AuthConfig['oauth2'] = null;
  if (env.JWT_ISSUER) {
    const issuer = env.JWT_ISSUER;
    oauth2 = {
      authorizationEndpoint: `${issuer}/protocol/openid-connect/auth`,
      tokenEndpoint: `${issuer}/protocol/openid-connect/token`,
      clientId: env.JWT_AUDIENCE || 'backups-registry',
      clientSecret: env.OIDC_CLIENT_SECRET || '',
      redirectUri: '', // always derived from request origin at runtime
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
  return config.basic !== null || config.jwtIssuer !== null || config.apiTokens.size > 0 || config.oauth2 !== null;
}

let cachedJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJWKSUri: string | null = null;
let cachedDiscoveryIssuer: string | null = null;
let cachedDiscoveredJwksUri: string | null = null;

async function resolveJwksUri(config: AuthConfig): Promise<string | null> {
  if (config.jwksUri) return config.jwksUri;
  if (!config.jwtIssuer) return null;

  if (cachedDiscoveryIssuer === config.jwtIssuer && cachedDiscoveredJwksUri) {
    return cachedDiscoveredJwksUri;
  }

  try {
    const discoveryUrl = `${config.jwtIssuer}/.well-known/openid-configuration`;
    const resp = await fetch(discoveryUrl);
    if (!resp.ok) throw new Error(`Discovery fetch failed: ${resp.status}`);
    const doc = await resp.json() as { jwks_uri?: string };
    if (!doc.jwks_uri) throw new Error('No jwks_uri in discovery document');
    cachedDiscoveryIssuer = config.jwtIssuer;
    cachedDiscoveredJwksUri = doc.jwks_uri;
    return doc.jwks_uri;
  } catch (e) {
    console.error('OIDC discovery failed:', e);
    return null;
  }
}

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
  if (!config.jwtIssuer) return false;

  const jwksUri = await resolveJwksUri(config);
  if (!jwksUri) {
    console.error('Could not resolve JWKS URI for issuer:', config.jwtIssuer);
    return false;
  }

  try {
    // For service account tokens (client_credentials), audience might be null
    // Only validate audience if the token actually has one
    const jwtAudience = config.jwtAudience || undefined;
    await jwtVerify(token, getJWKS(jwksUri), {
      issuer: config.jwtIssuer,
      audience: jwtAudience,
    });
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

async function refreshToken(refreshToken: string, config: AuthConfig): Promise<SessionTokens | null> {
  if (!config.oauth2?.tokenEndpoint) return null;

  try {
    const tokenResp = await fetch(config.oauth2.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.oauth2.clientId,
        client_secret: config.oauth2.clientSecret,
      }),
    });

    if (!tokenResp.ok) return null;

    const tokens = await tokenResp.json() as { access_token: string; id_token?: string; refresh_token?: string; expires_in?: number };
    if (!tokens.access_token) return null;

    return {
      accessToken: tokens.id_token || tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresAt: Date.now() + ((tokens.expires_in || 300) * 1000) - 300000,
    };
  } catch {
    return null;
  }
}

export async function authenticate(request: Request, env: Env, config?: AuthConfig): Promise<{ authenticated: boolean; redirect?: string }> {
  const cfg = config ?? getAuthConfig(env);
  console.log('authenticate: config', { jwtIssuer: cfg.jwtIssuer, apiTokens: cfg.apiTokens.size, oauth2: !!cfg.oauth2 });
  if (!isConfigured(cfg)) return { authenticated: true };

  const url = new URL(request.url);
  if (url.hostname === 'localhost') return { authenticated: true };

  const sessionCookie = request.headers.get('Cookie')?.match(/backup_registry_session=([^;]+)/)?.[1];
  if (sessionCookie) {
    try {
      const sessionData: SessionTokens = JSON.parse(atob(decodeURIComponent(sessionCookie)));

      if (Date.now() < sessionData.expiresAt) {
        if (await validateJWT(sessionData.accessToken, cfg)) return { authenticated: true };
      } else if (sessionData.refreshToken) {
        const refreshed = await refreshToken(sessionData.refreshToken, cfg);
        if (refreshed && await validateJWT(refreshed.accessToken, cfg)) {
          return { authenticated: true };
        }
      }
    } catch {}
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

  const accept = request.headers.get('Accept') || '';
  console.log('authenticate: no auth headers found, checking OAuth2', { oauth2: !!cfg.oauth2, accept });
  if (cfg.oauth2 && (accept.includes('text/html') || accept.includes('*/*') || !accept)) {
    console.log('authenticate: redirecting to OAuth2');
    const state = btoa(url.pathname + url.search);
    const redirectUri = `${url.origin}/oauth/callback`;
    const authUrl = new URL(cfg.oauth2.authorizationEndpoint);
    authUrl.searchParams.set('client_id', cfg.oauth2.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('scope', 'openid');
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
  if (config.jwtIssuer || config.apiTokens.size > 0) schemes.push('Bearer realm="backup-registry"');
  if (schemes.length === 0) schemes.push('Basic realm="backup-registry"');
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': schemes.join(', ') },
  });
}

export function createSessionCookie(tokens: SessionTokens, path: string = '/'): Response {
  const encoded = encodeURIComponent(btoa(JSON.stringify(tokens)));
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

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './durable-object';

interface AuthConfig {
  basic: { username: string; password: string } | null;
  jwtIssuer: string | null;
  jwtAudience: string | null;
  jwksUri: string | null;
  apiTokens: Set<string>;
}

function getConfig(env: Env): AuthConfig {
  const basic =
    env.AUTH_USER && env.AUTH_PASS
      ? { username: env.AUTH_USER, password: env.AUTH_PASS }
      : null;

  const apiTokens = env.API_TOKENS
    ? new Set(env.API_TOKENS.split(',').map(t => t.trim()).filter(Boolean))
    : new Set<string>();

  return {
    basic,
    jwtIssuer: env.JWT_ISSUER || null,
    jwtAudience: env.JWT_AUDIENCE || null,
    jwksUri: env.JWKS_URI || null,
    apiTokens,
  };
}

function isConfigured(config: AuthConfig): boolean {
  return config.basic !== null || config.jwtIssuer !== null || config.apiTokens.size > 0;
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

async function validateJWT(token: string, config: AuthConfig): Promise<boolean> {
  if (!config.jwtIssuer) return false;
  const jwksUri = config.jwksUri || `${config.jwtIssuer}/.well-known/jwks.json`;
  try {
    await jwtVerify(token, getJWKS(jwksUri), {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience || undefined,
    });
    return true;
  } catch {
    return false;
  }
}

function validateApiToken(token: string, config: AuthConfig): boolean {
  return config.apiTokens.has(token);
}

function validateBasicAuth(headerValue: string, config: AuthConfig): boolean {
  if (!config.basic) return false;
  const [scheme, encoded] = headerValue.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = atob(encoded);
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) return false;
  return decoded.substring(0, colonIdx) === config.basic.username &&
    decoded.substring(colonIdx + 1) === config.basic.password;
}

export async function authenticate(request: Request, env: Env): Promise<boolean> {
  const config = getConfig(env);
  if (!isConfigured(config)) return true;

  const url = new URL(request.url);
  if (url.hostname === 'localhost') return true;

  const authHeader = request.headers.get('Authorization');

  if (authHeader) {
    if (authHeader.startsWith('Basic ')) return validateBasicAuth(authHeader, config);
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (await validateJWT(token, config)) return true;
      if (validateApiToken(token, config)) return true;
      return false;
    }
    return false;
  }

  const apiKeyHeader = request.headers.get('X-API-Key');
  if (apiKeyHeader && validateApiToken(apiKeyHeader, config)) return true;

  return false;
}

export function unauthorized(env: Env): Response {
  const config = getConfig(env);
  const schemes: string[] = [];
  if (config.basic) schemes.push('Basic realm="backup-registry"');
  if (config.jwtIssuer || config.apiTokens.size > 0) schemes.push('Bearer realm="backup-registry"');
  if (schemes.length === 0) schemes.push('Basic realm="backup-registry"');
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': schemes.join(', ') },
  });
}

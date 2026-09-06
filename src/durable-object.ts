import { DurableObject } from 'cloudflare:workers';

export interface Env {
  BACKUP_STORE: DurableObjectNamespace<BackupRegistry>;
  AUTH_USER?: string;
  AUTH_PASS?: string;
  JWT_ISSUER?: string;
  JWT_AUDIENCE?: string;
  JWKS_URI?: string;
  API_TOKENS?: string;
  SITE_NAME?: string;
  DOCS_URL?: string;
  OIDC_CLIENT_SECRET?: string;
  KEYCLOAK_CLIENT_SECRET?: string;
  BASE_URL?: string;
  METRICS_API_TOKEN?: string;
}

export type BackupStatus = 'success' | 'failure' | 'partial';
export type EncryptionStatus = 'encrypted' | 'unencrypted' | 'partial' | 'failed';

export interface BackupRun {
  run_id: string;
  job_name: string;
  agent_id: string;
  start_time: string;
  end_time: string;
  status: BackupStatus;
  bytes_backed_up?: number;
  encrypted?: boolean;
  encryption_status?: EncryptionStatus;
  error?: string | null;
  backup_url?: string;
  metadata?: Record<string, unknown>;
  received_at: string;
}

export const MAX_BODY_SIZE = 1 * 1024 * 1024;
const KEY_PREFIX = 'run:';

export class BackupRegistry extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (method === 'POST' && path === '/submit') {
      const run = await request.json<BackupRun>();
      const key = `${KEY_PREFIX}${run.run_id}`;
      await this.ctx.storage.put(key, JSON.stringify(run));
      return Response.json(run, { status: 201 });
    }

    if (method === 'GET' && path === '/list') {
      const agentId = url.searchParams.get('agent_id');
      const jobName = url.searchParams.get('job_name');
      const status = url.searchParams.get('status');
      const since = url.searchParams.get('since');
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 1000);

      const entries = await this.ctx.storage.list<string>({ prefix: KEY_PREFIX });
      const runs: BackupRun[] = [];

      for (const [, value] of entries) {
        if (typeof value !== 'string') continue;
        const run = JSON.parse(value) as BackupRun;
        if (agentId && run.agent_id !== agentId) continue;
        if (jobName && run.job_name !== jobName) continue;
        if (status && run.status !== status) continue;
        if (since && new Date(run.received_at) < new Date(since)) continue;
        runs.push(run);
      }

      runs.sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime());
      return Response.json(runs.slice(0, limit));
    }

    if (method === 'GET' && path.startsWith('/get/')) {
      const runId = decodeURIComponent(path.slice(5));
      const stored = await this.ctx.storage.get<string>(`${KEY_PREFIX}${runId}`);
      if (!stored) return new Response('Not Found', { status: 404 });
      return new Response(stored, { headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'DELETE' && path.startsWith('/delete/')) {
      const runId = decodeURIComponent(path.slice(8));
      await this.ctx.storage.delete(`${KEY_PREFIX}${runId}`);
      return new Response(null, { status: 204 });
    }

    return new Response('Not Found', { status: 404 });
  }
}

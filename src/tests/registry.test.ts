import { SELF, reset, env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

const baseUrl = 'http://localhost';

const validRun = {
  run_id: '550e8400-e29b-41d4-a716-446655440001',
  job_name: 'postgres-daily',
  agent_id: 'agent-db-01',
  start_time: '2026-05-12T02:00:00Z',
  end_time: '2026-05-12T02:04:33Z',
  status: 'success',
  bytes_backed_up: 1073741824,
  encrypted: true,
  encryption_status: 'encrypted',
  error: null,
  metadata: { compression: 'zstd' },
};

function post(body: unknown) {
  return SELF.fetch(`${baseUrl}/v1/backup-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Backup Registry API', () => {
  beforeEach(async () => {
    await reset();
  });

  describe('POST /v1/backup-runs', () => {
    it('should accept and store a valid backup run', async () => {
      const resp = await post(validRun);
      expect(resp.status).toBe(201);
      const data = await resp.json() as Record<string, unknown>;
      expect(data.run_id).toBe(validRun.run_id);
      expect(data.job_name).toBe(validRun.job_name);
      expect(data.agent_id).toBe(validRun.agent_id);
      expect(data.status).toBe('success');
      expect(typeof data.received_at).toBe('string');
    });

    it('should accept a minimal run (only required fields)', async () => {
      const minimal = {
        run_id: 'min-run-001',
        job_name: 'simple-backup',
        agent_id: 'agent-01',
        start_time: '2026-05-12T01:00:00Z',
        end_time: '2026-05-12T01:30:00Z',
        status: 'failure',
      };
      const resp = await post(minimal);
      expect(resp.status).toBe(201);
    });

    it('should overwrite an existing run_id (idempotent)', async () => {
      await post(validRun);
      const updated = { ...validRun, status: 'failure', error: 'disk full' };
      const resp = await post(updated);
      expect(resp.status).toBe(201);

      const getResp = await SELF.fetch(`${baseUrl}/v1/backup-runs/${validRun.run_id}`);
      const data = await getResp.json() as Record<string, unknown>;
      expect(data.status).toBe('failure');
      expect(data.error).toBe('disk full');
    });

    it('should reject missing run_id', async () => {
      const { run_id, ...noId } = validRun;
      const resp = await post(noId);
      expect(resp.status).toBe(400);
      const data = await resp.json() as Record<string, unknown>;
      expect(typeof data.error).toBe('string');
    });

    it('should reject missing job_name', async () => {
      const { job_name, ...noJob } = validRun;
      const resp = await post(noJob);
      expect(resp.status).toBe(400);
    });

    it('should reject missing agent_id', async () => {
      const { agent_id, ...noAgent } = validRun;
      const resp = await post(noAgent);
      expect(resp.status).toBe(400);
    });

    it('should reject invalid start_time', async () => {
      const resp = await post({ ...validRun, start_time: 'not-a-date' });
      expect(resp.status).toBe(400);
    });

    it('should reject invalid status', async () => {
      const resp = await post({ ...validRun, status: 'unknown' });
      expect(resp.status).toBe(400);
    });

    it('should reject invalid bytes_backed_up', async () => {
      const resp = await post({ ...validRun, bytes_backed_up: -1 });
      expect(resp.status).toBe(400);
    });

    it('should reject invalid encryption_status', async () => {
      const resp = await post({ ...validRun, encryption_status: 'maybe' });
      expect(resp.status).toBe(400);
    });

    it('should reject invalid JSON body', async () => {
      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      expect(resp.status).toBe(400);
    });

    it('should reject array body', async () => {
      const resp = await post([validRun]);
      expect(resp.status).toBe(400);
    });
  });

  describe('GET /v1/backup-runs', () => {
    it('should return empty array when no runs exist', async () => {
      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs`);
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual([]);
    });

    it('should list submitted runs sorted newest first', async () => {
      const run1 = { ...validRun, run_id: 'run-001', job_name: 'job-a' };
      const run2 = { ...validRun, run_id: 'run-002', job_name: 'job-b' };
      await post(run1);
      await post(run2);

      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs`);
      const data = await resp.json() as Array<Record<string, unknown>>;
      expect(data).toHaveLength(2);
      expect(data.every(r => typeof r.received_at === 'string')).toBe(true);
    });

    it('should filter by agent_id', async () => {
      await post({ ...validRun, run_id: 'r1', agent_id: 'agent-a' });
      await post({ ...validRun, run_id: 'r2', agent_id: 'agent-b' });

      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs?agent_id=agent-a`);
      const data = await resp.json() as Array<Record<string, unknown>>;
      expect(data).toHaveLength(1);
      expect(data[0].agent_id).toBe('agent-a');
    });

    it('should filter by job_name', async () => {
      await post({ ...validRun, run_id: 'r1', job_name: 'job-x' });
      await post({ ...validRun, run_id: 'r2', job_name: 'job-y' });

      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs?job_name=job-y`);
      const data = await resp.json() as Array<Record<string, unknown>>;
      expect(data).toHaveLength(1);
      expect(data[0].job_name).toBe('job-y');
    });

    it('should filter by status', async () => {
      await post({ ...validRun, run_id: 'r1', status: 'success' });
      await post({ ...validRun, run_id: 'r2', status: 'failure' });
      await post({ ...validRun, run_id: 'r3', status: 'partial' });

      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs?status=failure`);
      const data = await resp.json() as Array<Record<string, unknown>>;
      expect(data).toHaveLength(1);
      expect(data[0].status).toBe('failure');
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await post({ ...validRun, run_id: `run-${i}` });
      }
      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs?limit=3`);
      const data = await resp.json() as Array<unknown>;
      expect(data).toHaveLength(3);
    });
  });

  describe('GET /v1/backup-runs/:run_id', () => {
    it('should return a specific run', async () => {
      await post(validRun);
      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs/${validRun.run_id}`);
      expect(resp.status).toBe(200);
      const data = await resp.json() as Record<string, unknown>;
      expect(data.run_id).toBe(validRun.run_id);
      expect(data.job_name).toBe(validRun.job_name);
      expect(data.bytes_backed_up).toBe(validRun.bytes_backed_up);
    });

    it('should return 404 for unknown run_id', async () => {
      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs/nonexistent-id`);
      expect(resp.status).toBe(404);
    });

    it('should handle run_id with special characters (URL encoded)', async () => {
      const specialId = 'run/2026-05-12:job1';
      await post({ ...validRun, run_id: specialId });
      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs/${encodeURIComponent(specialId)}`);
      expect(resp.status).toBe(200);
      const data = await resp.json() as Record<string, unknown>;
      expect(data.run_id).toBe(specialId);
    });
  });

  describe('DELETE /v1/backup-runs/:run_id', () => {
    it('should delete an existing run', async () => {
      await post(validRun);

      const delResp = await SELF.fetch(
        `${baseUrl}/v1/backup-runs/${validRun.run_id}`,
        { method: 'DELETE' }
      );
      expect(delResp.status).toBe(204);

      const getResp = await SELF.fetch(`${baseUrl}/v1/backup-runs/${validRun.run_id}`);
      expect(getResp.status).toBe(404);
    });

    it('should return 204 even for a non-existent run_id (idempotent)', async () => {
      const resp = await SELF.fetch(
        `${baseUrl}/v1/backup-runs/does-not-exist`,
        { method: 'DELETE' }
      );
      expect(resp.status).toBe(204);
    });

    it('should not affect other runs when deleting one', async () => {
      await post({ ...validRun, run_id: 'keep-me' });
      await post({ ...validRun, run_id: 'delete-me' });

      await SELF.fetch(`${baseUrl}/v1/backup-runs/delete-me`, { method: 'DELETE' });

      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs`);
      const data = await resp.json() as Array<Record<string, unknown>>;
      expect(data).toHaveLength(1);
      expect(data[0].run_id).toBe('keep-me');
    });
  });

  describe('GET /', () => {
    it('should return HTML UI', async () => {
      const resp = await SELF.fetch(`${baseUrl}/`);
      expect(resp.status).toBe(200);
      expect(resp.headers.get('Content-Type')).toContain('text/html');
      const body = await resp.text();
      expect(body).toContain('Backup Registry');
    });

    it('should display submitted runs in UI', async () => {
      await post(validRun);
      const resp = await SELF.fetch(`${baseUrl}/`);
      const body = await resp.text();
      expect(body).toContain('postgres-daily');
      expect(body).toContain('agent-db-01');
    });

    it('should show zero stats when no runs', async () => {
      const resp = await SELF.fetch(`${baseUrl}/`);
      const body = await resp.text();
      expect(body).toContain('Backup Registry');
      expect(body).toContain('No backup runs found');
    });
  });

  describe('GET /docs', () => {
    it('should return HTML docs', async () => {
      const resp = await SELF.fetch(`${baseUrl}/docs`);
      expect(resp.status).toBe(200);
      expect(resp.headers.get('Content-Type')).toContain('text/html');
      const body = await resp.text();
      expect(body).toContain('Backup Registry API');
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const resp = await SELF.fetch(`${baseUrl}/health`);
      expect(resp.status).toBe(200);
      const data = await resp.json() as Record<string, unknown>;
      expect(data.status).toBe('healthy');
      expect(typeof data.version).toBe('string');
      expect(typeof data.timestamp).toBe('string');
    });
  });

  describe('Method routing', () => {
    it('should return 405 for unsupported methods on /v1/backup-runs', async () => {
      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs`, { method: 'PUT' });
      expect(resp.status).toBe(405);
    });

    it('should return 404 for unknown paths', async () => {
      const resp = await SELF.fetch(`${baseUrl}/unknown/path`);
      expect(resp.status).toBe(404);
    });
  });

  describe('Authentication', () => {
    const hasBasicAuth = !!(env as Record<string, unknown>).AUTH_USER;
    const hasApiToken = !!(env as Record<string, unknown>).API_TOKENS;

    (hasBasicAuth ? it : it.skip)('should reject unauthenticated requests when auth is configured', async () => {
      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs`);
      expect(resp.status).toBe(401);
    });

    (hasBasicAuth ? it : it.skip)('should accept basic auth credentials', async () => {
      const user = (env as Record<string, unknown>).AUTH_USER as string;
      const pass = (env as Record<string, unknown>).AUTH_PASS as string;
      const encoded = btoa(`${user}:${pass}`);
      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs`, {
        headers: { Authorization: `Basic ${encoded}` },
      });
      expect(resp.status).toBe(200);
    });

    (hasApiToken ? it : it.skip)('should accept API token via Bearer header', async () => {
      const token = ((env as Record<string, unknown>).API_TOKENS as string).split(',')[0].trim();
      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(resp.status).toBe(200);
    });

    (hasApiToken ? it : it.skip)('should accept API token via X-API-Key header', async () => {
      const token = ((env as Record<string, unknown>).API_TOKENS as string).split(',')[0].trim();
      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs`, {
        headers: { 'X-API-Key': token },
      });
      expect(resp.status).toBe(200);
    });

    (hasApiToken ? it : it.skip)('should reject an invalid Bearer token', async () => {
      const resp = await SELF.fetch(`${baseUrl}/v1/backup-runs`, {
        headers: { Authorization: 'Bearer bad-token' },
      });
      expect(resp.status).toBe(401);
    });
  });
});

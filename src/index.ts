import { BackupRegistry, Env, BackupRun, BackupStatus, EncryptionStatus, MAX_BODY_SIZE } from './durable-object';
import { authenticate, unauthorized, getAuthConfig, createSessionCookie, clearSessionCookie } from './auth';

export { BackupRegistry };

const VERSION = '0.5.2';

const FAVICON_B64 = 'AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//98NP//fDT//3w0//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
const VALID_STATUSES: BackupStatus[] = ['success', 'failure', 'partial'];
const VALID_ENC_STATUSES: EncryptionStatus[] = ['encrypted', 'unencrypted', 'partial', 'failed'];

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'",
};

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS },
  });
}


function getSiteName(request: Request, env: Env): string {
  if (env.SITE_NAME) return env.SITE_NAME;
  const host = new URL(request.url).hostname;
  if (host === 'localhost' || host === '127.0.0.1') return 'Backup Registry';
  // Strip leading 'backups.' prefix if present, e.g. backups.golder.tech → golder.tech
  return host.replace(/^backups\./, '');
}

function getStore(env: Env): DurableObjectStub<BackupRegistry> {
  const id = env.BACKUP_STORE.idFromName('registry');
  return env.BACKUP_STORE.get(id);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '—';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatDuration(startTime: string, endTime: string): string {
  const ms = new Date(endTime).getTime() - new Date(startTime).getTime();
  if (isNaN(ms) || ms < 0) return '—';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

type ValidationResult =
  | { ok: true; run: Omit<BackupRun, 'received_at'> }
  | { ok: false; error: string };

function validatePayload(data: unknown): ValidationResult {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const d = data as Record<string, unknown>;

  if (typeof d.run_id !== 'string' || !d.run_id.trim()) {
    return { ok: false, error: 'run_id is required and must be a non-empty string' };
  }
  if (typeof d.job_name !== 'string' || !d.job_name.trim()) {
    return { ok: false, error: 'job_name is required and must be a non-empty string' };
  }
  if (typeof d.agent_id !== 'string' || !d.agent_id.trim()) {
    return { ok: false, error: 'agent_id is required and must be a non-empty string' };
  }
  if (typeof d.start_time !== 'string' || isNaN(new Date(d.start_time).getTime())) {
    return { ok: false, error: 'start_time must be a valid ISO8601 timestamp' };
  }
  if (typeof d.end_time !== 'string' || isNaN(new Date(d.end_time).getTime())) {
    return { ok: false, error: 'end_time must be a valid ISO8601 timestamp' };
  }
  if (!VALID_STATUSES.includes(d.status as BackupStatus)) {
    return { ok: false, error: `status must be one of: ${VALID_STATUSES.join(', ')}` };
  }
  if (d.bytes_backed_up !== undefined && (typeof d.bytes_backed_up !== 'number' || d.bytes_backed_up < 0 || !Number.isFinite(d.bytes_backed_up))) {
    return { ok: false, error: 'bytes_backed_up must be a non-negative finite number' };
  }
  if (d.encrypted !== undefined && typeof d.encrypted !== 'boolean') {
    return { ok: false, error: 'encrypted must be a boolean' };
  }
  if (d.encryption_status !== undefined && !VALID_ENC_STATUSES.includes(d.encryption_status as EncryptionStatus)) {
    return { ok: false, error: `encryption_status must be one of: ${VALID_ENC_STATUSES.join(', ')}` };
  }
  if (d.error !== undefined && d.error !== null && typeof d.error !== 'string') {
    return { ok: false, error: 'error must be a string or null' };
  }
  if (d.backup_url !== undefined && d.backup_url !== null) {
    if (typeof d.backup_url !== 'string') return { ok: false, error: 'backup_url must be a string' };
    let parsedUrl: URL;
    try { parsedUrl = new URL(d.backup_url); } catch { return { ok: false, error: 'backup_url must be a valid URL' }; }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { ok: false, error: 'backup_url must use http or https' };
    }
  }
  if (d.metadata !== undefined && (typeof d.metadata !== 'object' || d.metadata === null || Array.isArray(d.metadata))) {
    return { ok: false, error: 'metadata must be a plain object' };
  }

  return {
    ok: true,
    run: {
      run_id: d.run_id as string,
      job_name: d.job_name as string,
      agent_id: d.agent_id as string,
      start_time: d.start_time as string,
      end_time: d.end_time as string,
      status: d.status as BackupStatus,
      bytes_backed_up: d.bytes_backed_up as number | undefined,
      encrypted: d.encrypted as boolean | undefined,
      encryption_status: d.encryption_status as EncryptionStatus | undefined,
      error: d.error as string | null | undefined,
      backup_url: d.backup_url as string | undefined,
      metadata: d.metadata as Record<string, unknown> | undefined,
    },
  };
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  let rawBody: ArrayBuffer;
  try {
    rawBody = await request.arrayBuffer();
  } catch {
    return Response.json({ error: 'Failed to read request body' }, { status: 400 });
  }
  if (rawBody.byteLength > MAX_BODY_SIZE) {
    return Response.json({ error: 'Request body too large' }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const result = validatePayload(body);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  const run: BackupRun = { ...result.run, received_at: new Date().toISOString() };
  const store = getStore(env);
  return store.fetch(new Request('http://do/submit', {
    method: 'POST',
    body: JSON.stringify(run),
    headers: { 'Content-Type': 'application/json' },
  }));
}

async function handleList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  for (const key of ['agent_id', 'job_name', 'status', 'since', 'limit']) {
    const val = url.searchParams.get(key);
    if (val !== null) params.set(key, val);
  }
  const store = getStore(env);
  return store.fetch(`http://do/list?${params}`);
}

async function handleGetRun(runId: string, env: Env): Promise<Response> {
  const store = getStore(env);
  return store.fetch(`http://do/get/${encodeURIComponent(runId)}`);
}

async function handleDeleteRun(runId: string, env: Env): Promise<Response> {
  const store = getStore(env);
  return store.fetch(new Request(`http://do/delete/${encodeURIComponent(runId)}`, { method: 'DELETE' }));
}

function statusBadge(status: BackupStatus): string {
  const classes: Record<BackupStatus, string> = {
    success: 'badge-success',
    failure: 'badge-failure',
    partial: 'badge-partial',
  };
  return `<span class="badge ${classes[status] || ''}">${escapeHtml(status)}</span>`;
}

function encBadge(status?: EncryptionStatus): string {
  if (!status) return '—';
  const classes: Record<EncryptionStatus, string> = {
    encrypted: 'badge-encrypted',
    unencrypted: 'badge-unencrypted',
    partial: 'badge-partial',
    failed: 'badge-failure',
  };
  return `<span class="badge ${classes[status] || ''}">${escapeHtml(status)}</span>`;
}

async function handleUI(request: Request, env: Env, siteName: string, docsUrl: string): Promise<Response> {
  const url = new URL(request.url);
  const filterAgent = url.searchParams.get('agent_id') || '';
  const filterJob = url.searchParams.get('job_name') || '';
  const filterStatus = url.searchParams.get('status') || '';
  const limit = url.searchParams.get('limit') || '100';
  // Text filters (agent/job) switch to "all runs" mode. Status alone stays in "latest per job" mode.
  const isFiltered = !!(filterAgent || filterJob);

  const store = getStore(env);

  // Always fetch all runs to compute stat card totals from the global view.
  const resp = await store.fetch('http://do/list?limit=1000');
  const allRuns: BackupRun[] = await resp.json();

  // Build latest-per-job map — used for stat cards and the default (unfiltered) table view.
  // "Latest" is the run with the most recent end_time (when the backup actually completed).
  const jobMap = new Map<string, { latest: BackupRun; count: number }>();
  for (const run of allRuns) {
    const existing = jobMap.get(run.job_name);
    if (!existing) {
      jobMap.set(run.job_name, { latest: run, count: 1 });
    } else {
      existing.count++;
      if (new Date(run.end_time) > new Date(existing.latest.end_time)) {
        existing.latest = run;
      }
    }
  }

  // Stat card totals always reflect the global latest-per-job picture, ignoring active filters.
  const totalSuccess = Array.from(jobMap.values()).filter(({ latest }) => latest.status === 'success').length;
  const totalFailure = Array.from(jobMap.values()).filter(({ latest }) => latest.status === 'failure').length;
  const totalPartial = Array.from(jobMap.values()).filter(({ latest }) => latest.status === 'partial').length;

  interface DisplayRow { run: BackupRun; historyCount?: number }
  let displayRows: DisplayRow[];

  if (isFiltered) {
    // Text-filtered view: show all matching runs (case-insensitive partial match).
    let filtered = allRuns;
    if (filterAgent) {
      const agentLower = filterAgent.toLowerCase();
      filtered = filtered.filter(r => r.agent_id.toLowerCase().includes(agentLower));
    }
    if (filterJob) {
      const jobLower = filterJob.toLowerCase();
      filtered = filtered.filter(r => r.job_name.toLowerCase().includes(jobLower));
    }
    if (filterStatus) {
      filtered = filtered.filter(r => r.status === filterStatus);
    }
    displayRows = filtered.slice(0, parseInt(limit, 10)).map(run => ({ run }));
  } else {
    // Default view: latest per job. Status filter applied after grouping.
    let jobRows = Array.from(jobMap.values())
      .sort((a, b) => new Date(b.latest.end_time).getTime() - new Date(a.latest.end_time).getTime());
    if (filterStatus) {
      jobRows = jobRows.filter(({ latest }) => latest.status === filterStatus);
    }
    displayRows = jobRows.map(({ latest, count }) => ({ run: latest, historyCount: count }));
  }

  const statusOptions = ['', 'success', 'failure', 'partial']
    .map(s => `<option value="${s}"${filterStatus === s ? ' selected' : ''}>${s || 'All statuses'}</option>`)
    .join('');

  const colspan = isFiltered ? 9 : 10;
  let rows = '';
  if (displayRows.length === 0) {
    rows = `<tr><td colspan="${colspan}" class="empty">No backup runs found.</td></tr>`;
  } else {
    for (const { run, historyCount } of displayRows) {
      const errCell = run.error
        ? `<span class="error-text" title="${escapeHtml(run.error)}">${escapeHtml(run.error.substring(0, 60))}${run.error.length > 60 ? '…' : ''}</span>`
        : '—';
      const jobCell = isFiltered
        ? `<strong>${escapeHtml(run.job_name)}</strong>`
        : `<a href="/?job_name=${encodeURIComponent(run.job_name)}" class="job-link"><strong>${escapeHtml(run.job_name)}</strong></a>`;
      const historyCell = historyCount !== undefined
        ? `<a href="/?job_name=${encodeURIComponent(run.job_name)}" class="history-link" title="View all runs for this job">${historyCount} run${historyCount !== 1 ? 's' : ''}</a>`
        : '';
      const durationMs = new Date(run.end_time).getTime() - new Date(run.start_time).getTime();
      const durationSort = isNaN(durationMs) || durationMs < 0 ? -1 : durationMs;
      rows += `<tr>
        <td data-sort="${escapeHtml(run.job_name.toLowerCase())}">${jobCell}</td>
        <td data-sort="${escapeHtml(run.agent_id.toLowerCase())}">${escapeHtml(run.agent_id)}</td>
        <td data-sort="${escapeHtml(run.status)}">${statusBadge(run.status)}</td>
        <td data-sort="${escapeHtml(run.start_time)}">${escapeHtml(formatTime(run.start_time))}</td>
        <td data-sort="${durationSort}">${escapeHtml(formatDuration(run.start_time, run.end_time))}</td>
        <td data-sort="${run.bytes_backed_up ?? -1}">${escapeHtml(formatBytes(run.bytes_backed_up))}</td>
        <td data-sort="${escapeHtml(run.encryption_status || '')}">${encBadge(run.encryption_status)}</td>
        <td data-sort="${escapeHtml(run.error || '')}">${errCell}</td>
        ${!isFiltered ? `<td class="history-col" data-sort="${historyCount ?? 0}">${historyCell}</td>` : ''}
        <td class="actions">
          <a class="btn-view" href="/run/${encodeURIComponent(run.run_id)}">View</a>
          ${run.backup_url ? `<a class="btn-download" href="${escapeHtml(run.backup_url)}" target="_blank" rel="noopener noreferrer">Download</a>` : ''}
          <button class="btn-del" onclick="delRun(${escapeHtml(JSON.stringify(run.run_id))})">Delete</button>
        </td>
      </tr>`;
    }
  }

  const tableCaption = isFiltered
    ? `<p class="table-caption">${displayRows.length} run${displayRows.length !== 1 ? 's' : ''} matching filter &mdash; <a href="/">Back to overview</a></p>`
    : `<p class="table-caption">Latest backup per job &mdash; click job name or run count to see full history</p>`;

  const noStatusParams = new URLSearchParams();
  if (filterAgent) noStatusParams.set('agent_id', filterAgent);
  if (filterJob) noStatusParams.set('job_name', filterJob);
  const noStatusHref = noStatusParams.toString() ? '/?' + noStatusParams.toString() : '/';
  const statusHref = (s: string) => {
    const p = new URLSearchParams(noStatusParams);
    p.set('status', s);
    return '/?' + p.toString();
  };
  const theadExtra = isFiltered ? '' : '<th class="sortable" data-col="8" onclick="sortTable(8)">History</th>';
  const startTimeHeader = isFiltered ? 'Start Time' : 'Last Run';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(siteName)} — Backup Registry</title>
  <link rel="icon" href="/favicon.ico">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #1a1a1a; color: #e0e0e0; }
    h1 { margin: 0 0 4px 0; color: #4fc3f7; font-size: 24px; }
    .header { margin-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-start; }
    .header-left p { margin: 4px 0; color: #b0b0b0; font-size: 14px; }
    .stats { display: flex; gap: 12px; margin-bottom: 16px; }
    .stat-card { background: #2d2d2d; border: 1px solid #444; border-radius: 8px; padding: 12px 20px; text-align: center; min-width: 100px; }
    .stat-card .count { font-size: 28px; font-weight: 700; }
    .stat-card .label { font-size: 12px; color: #aaa; text-transform: uppercase; }
    a.stat-link { text-decoration: none; cursor: pointer; }
    a.stat-link:hover { border-color: #888; background: #333; }
    .count-total { color: #e0e0e0; }
    .count-success { color: #81c784; }
    .count-failure { color: #e57373; }
    .count-partial { color: #ffb74d; }
    .filter-form { background: #2d2d2d; border: 1px solid #444; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
    .filter-form label { font-size: 12px; color: #aaa; display: flex; flex-direction: column; gap: 4px; }
    .filter-form input, .filter-form select { background: #1a1a1a; border: 1px solid #555; border-radius: 4px; padding: 6px 10px; color: #e0e0e0; font-size: 13px; min-width: 140px; }
    .filter-form button { background: #4fc3f7; border: none; border-radius: 4px; padding: 7px 16px; color: #1a1a1a; font-size: 13px; font-weight: 600; cursor: pointer; }
    .filter-form button:hover { background: #81d4fa; }
    .filter-form a { font-size: 12px; color: #aaa; text-decoration: none; align-self: center; }
    .filter-form a:hover { color: #e0e0e0; }
    .btn-clear { background: #444; border: 1px solid #666; border-radius: 4px; padding: 7px 16px; color: #e0e0e0 !important; font-size: 13px; font-weight: 600; align-self: flex-end; }
    .btn-clear:hover { background: #555; color: #e0e0e0 !important; }
    .table-caption { margin: 0 0 8px 0; font-size: 13px; color: #888; }
    .table-caption a { color: #4fc3f7; text-decoration: none; }
    .table-caption a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; background: #2d2d2d; border: 1px solid #444; border-radius: 8px; overflow: hidden; }
    th { background: #333; padding: 10px 12px; text-align: left; font-size: 12px; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #555; }
    td { padding: 9px 12px; border-bottom: 1px solid #333; font-size: 13px; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #353535; }
    .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; display: inline-block; }
    .badge-success { background: #1b5e20; color: #a5d6a7; border: 1px solid #388e3c; }
    .badge-failure { background: #b71c1c; color: #ffcdd2; border: 1px solid #d32f2f; }
    .badge-partial { background: #e65100; color: #ffe0b2; border: 1px solid #f57c00; }
    .badge-encrypted { background: #1b5e20; color: #a5d6a7; border: 1px solid #388e3c; }
    .badge-unencrypted { background: #b71c1c; color: #ffcdd2; border: 1px solid #d32f2f; }
    .error-text { color: #e57373; font-size: 12px; }
    .empty { color: #888; font-style: italic; text-align: center; padding: 24px; }
    .actions { white-space: nowrap; }
    .actions button, .actions a { background: #444; border: 1px solid #666; border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 12px; color: #e0e0e0; margin-left: 4px; text-decoration: none; display: inline-block; }
    .actions button:hover, .actions a:hover { background: #555; }
    .btn-del:hover { color: #e57373; border-color: #e57373; }
    .btn-view:hover { color: #4fc3f7; border-color: #4fc3f7; }
    .btn-download { color: #81c784 !important; border-color: #388e3c !important; }
    .btn-download:hover { background: #1b3a1b !important; }
    th.sortable { cursor: pointer; user-select: none; }
    th.sortable:hover { color: #e0e0e0; background: #3a3a3a; }
    th.sortable::after { content: ' ⇕'; opacity: 0.25; font-size: 10px; }
    th.sort-asc::after { content: ' ▲'; opacity: 1; }
    th.sort-desc::after { content: ' ▼'; opacity: 1; }
    .job-link { color: #e0e0e0; text-decoration: none; }
    .job-link:hover { color: #4fc3f7; }
    .history-col { white-space: nowrap; }
    .history-link { color: #888; font-size: 12px; text-decoration: none; border: 1px solid #555; border-radius: 10px; padding: 1px 8px; }
    .history-link:hover { color: #4fc3f7; border-color: #4fc3f7; }
    .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .footer { margin-top: 20px; font-size: 12px; color: #888; text-align: center; padding: 16px; border-top: 1px solid #444; }
    .footer-nav { margin-bottom: 12px; display: flex; justify-content: center; gap: 16px; flex-wrap: wrap; }
    .footer-nav a { color: #4fc3f7; text-decoration: none; font-size: 13px; padding: 4px 8px; border-radius: 4px; }
    .footer-nav a:hover { background-color: #333; }
    @media (max-width: 700px) {
      body { padding: 12px; }
      h1 { font-size: 20px; }
      .stats { flex-wrap: wrap; gap: 8px; }
      .stat-card { min-width: 70px; padding: 8px 12px; }
      .stat-card .count { font-size: 22px; }
      .filter-form { gap: 8px; padding: 10px 12px; }
      .filter-form input, .filter-form select { min-width: 0; }
      table { min-width: 640px; font-size: 12px; }
      td, th { padding: 7px 8px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>${escapeHtml(siteName)}</h1>
      <p>Backup run reports from registered agents</p>
    </div>
    <div style="display:flex;align-items:center;gap:12px;">
      ${docsUrl ? `<a href="${escapeHtml(docsUrl)}" target="_blank" rel="noopener noreferrer" style="color:#4fc3f7;text-decoration:none;font-size:14px;">Docs</a>` : ''}
      <a href="/logout" style="color: #ff6b6b; text-decoration: none; font-size: 13px; padding: 4px 8px; border-radius: 4px;">Logout</a>
    </div>
  </div>

  <div class="stats">
    <a class="stat-card stat-link" href="${noStatusHref}"><div class="count count-total">${jobMap.size}</div><div class="label">Jobs</div></a>
    <a class="stat-card stat-link" href="${statusHref('success')}"><div class="count count-success">${totalSuccess}</div><div class="label">Success</div></a>
    <a class="stat-card stat-link" href="${statusHref('failure')}"><div class="count count-failure">${totalFailure}</div><div class="label">Failure</div></a>
    <a class="stat-card stat-link" href="${statusHref('partial')}"><div class="count count-partial">${totalPartial}</div><div class="label">Partial</div></a>
  </div>

  <form class="filter-form" method="get" action="/">
    <label>Agent ID <input type="text" name="agent_id" value="${escapeHtml(filterAgent)}" placeholder="any"></label>
    <label>Job Name <input type="text" name="job_name" value="${escapeHtml(filterJob)}" placeholder="any"></label>
    <label>Status <select name="status">${statusOptions}</select></label>
    <label>Limit <input type="number" name="limit" value="${escapeHtml(limit)}" min="1" max="1000" style="min-width:80px;"></label>
    <button type="submit">Filter</button>
    ${isFiltered ? '<a href="/" class="btn-clear">Clear</a>' : ''}
  </form>

  ${tableCaption}
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th class="sortable" data-col="0" onclick="sortTable(0)">Job</th>
        <th class="sortable" data-col="1" onclick="sortTable(1)">Agent</th>
        <th class="sortable" data-col="2" onclick="sortTable(2)">Status</th>
        <th class="sortable" data-col="3" onclick="sortTable(3)">${startTimeHeader}</th>
        <th class="sortable" data-col="4" onclick="sortTable(4)">Duration</th>
        <th class="sortable" data-col="5" onclick="sortTable(5)">Size</th>
        <th class="sortable" data-col="6" onclick="sortTable(6)">Encryption</th>
        <th class="sortable" data-col="7" onclick="sortTable(7)">Error</th>
        ${theadExtra}
        <th></th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  </div>

  <script>
    let _sortCol = -1, _sortDir = 1;
    function sortTable(col) {
      _sortDir = (_sortCol === col) ? -_sortDir : 1;
      _sortCol = col;
      const tbody = document.querySelector('table tbody');
      const rows = Array.from(tbody.rows);
      if (rows.length <= 1) return;
      rows.sort((a, b) => {
        const aCell = a.cells[col], bCell = b.cells[col];
        if (!aCell || !bCell) return 0;
        const aVal = aCell.dataset.sort ?? '', bVal = bCell.dataset.sort ?? '';
        const aNum = parseFloat(aVal), bNum = parseFloat(bVal);
        if (!isNaN(aNum) && !isNaN(bNum)) return (aNum - bNum) * _sortDir;
        return aVal.localeCompare(bVal) * _sortDir;
      });
      rows.forEach(r => tbody.appendChild(r));
      document.querySelectorAll('th.sortable').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (parseInt(th.dataset.col) === col) th.classList.add(_sortDir === 1 ? 'sort-asc' : 'sort-desc');
      });
    }
    async function delRun(runId) {
      if (!confirm('Delete this backup run record?')) return;
      try {
        const r = await fetch('/v1/backup-runs/' + encodeURIComponent(runId), { method: 'DELETE' });
        if (r.ok) location.reload();
        else alert('Delete failed: ' + r.status);
      } catch(e) { alert('Error: ' + e.message); }
    }
  </script>

  <div class="footer">
    <div class="footer-nav">
      <a href="/">Home</a>
      <a href="/v1/backup-runs">API</a>
      <a href="/metrics">Metrics</a>
      <a href="/health">Health</a>
      <a href="/docs">Docs</a>
    </div>
    cloudflare-backup-registry v${VERSION}
  </div>
</body>
</html>`;

  return htmlResponse(html);
}

async function handleDocs(): Promise<Response> {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Docs - Backup Registry</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #1a1a1a; color: #e0e0e0; }
    h1 { margin: 0 0 8px 0; color: #4fc3f7; font-size: 24px; }
    .header { margin-bottom: 20px; }
    .section { background: #2d2d2d; border: 1px solid #444; border-radius: 8px; margin-bottom: 20px; overflow: hidden; }
    .section-header { background: #333; padding: 14px 16px; border-bottom: 1px solid #555; }
    .section-header h2 { margin: 0; font-size: 16px; color: #e0e0e0; }
    .section-content { padding: 16px; }
    pre { background: #1a1a1a; border: 1px solid #444; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 13px; color: #e0e0e0; margin: 8px 0; }
    code { background: #444; padding: 2px 6px; border-radius: 3px; font-size: 12px; color: #e0e0e0; }
    h3 { margin: 16px 0 6px 0; color: #4fc3f7; font-size: 14px; }
    p { margin: 6px 0; font-size: 14px; line-height: 1.5; }
    ul { margin: 6px 0; padding-left: 20px; font-size: 14px; line-height: 1.7; }
    .footer { margin-top: 20px; font-size: 12px; color: #888; text-align: center; padding: 16px; border-top: 1px solid #444; }
    .footer-nav { margin-bottom: 12px; display: flex; justify-content: center; gap: 16px; flex-wrap: wrap; }
    .footer-nav a { color: #4fc3f7; text-decoration: none; font-size: 13px; padding: 4px 8px; border-radius: 4px; }
    .footer-nav a:hover { background-color: #333; }
    .method-badge { display: inline-block; padding: 1px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; margin-right: 6px; }
    .POST { background: #1b5e20; color: #a5d6a7; }
    .GET { background: #0d47a1; color: #90caf9; }
    .DELETE { background: #b71c1c; color: #ffcdd2; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Backup Registry API</h1>
    <p style="color:#b0b0b0;font-size:14px;">v${VERSION} &mdash; Submit and query backup run reports</p>
  </div>

  <div class="section">
    <div class="section-header"><h2>Authentication</h2></div>
    <div class="section-content">
      <p>Three methods are supported (checked in order):</p>
      <ul>
        <li><strong>Bearer token</strong> — <code>Authorization: Bearer &lt;token&gt;</code> (API token or JWT)</li>
        <li><strong>X-API-Key header</strong> — <code>X-API-Key: &lt;token&gt;</code></li>
        <li><strong>Basic auth</strong> — <code>Authorization: Basic &lt;base64(user:pass)&gt;</code></li>
      </ul>
      <p>Set <code>API_TOKENS</code> (comma-separated) as a Cloudflare Secret for agent authentication.<br>
      Set <code>AUTH_USER</code> / <code>AUTH_PASS</code> for UI/admin access.</p>
      <pre>npx wrangler secret put API_TOKENS
npx wrangler secret put AUTH_USER
npx wrangler secret put AUTH_PASS</pre>
      <p>Authentication is bypassed for localhost requests (development/testing).</p>
    </div>
  </div>

  <div class="section">
    <div class="section-header"><h2>Submit a Backup Run</h2></div>
    <div class="section-content">
      <p><span class="method-badge POST">POST</span><code>/v1/backup-runs</code></p>
      <p>Submit a backup run report. The server adds <code>received_at</code>. Submitting an existing <code>run_id</code> overwrites it (idempotent).</p>
      <h3>Request body</h3>
      <pre>{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",  // required — unique run identifier
  "job_name": "postgres-daily",                        // required
  "agent_id": "agent-prod-db-01",                      // required
  "start_time": "2026-05-12T02:00:00Z",               // required — ISO8601
  "end_time": "2026-05-12T02:04:33Z",                 // required — ISO8601
  "status": "success",                                  // required — success|failure|partial
  "bytes_backed_up": 1073741824,                        // optional
  "encrypted": true,                                    // optional
  "encryption_status": "encrypted",                     // optional — encrypted|unencrypted|partial|failed
  "error": null,                                        // optional — string or null
  "backup_url": "https://s3.example.com/backup.tar.gz", // optional — download URL for the backup
  "metadata": { "compression": "zstd" }                // optional — arbitrary object
}</pre>
      <h3>Example</h3>
      <pre>curl -s -X POST https://backup-registry.golder.tech/v1/backup-runs \\
  -H "Authorization: Bearer &lt;token&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"run_id":"...","job_name":"postgres-daily","agent_id":"db-01","start_time":"2026-05-12T02:00:00Z","end_time":"2026-05-12T02:04:33Z","status":"success"}'</pre>
      <p>Returns <code>201 Created</code> with the stored run object on success, or <code>400 Bad Request</code> with <code>{"error":"..."}</code> on validation failure.</p>
    </div>
  </div>

  <div class="section">
    <div class="section-header"><h2>List Backup Runs</h2></div>
    <div class="section-content">
      <p><span class="method-badge GET">GET</span><code>/v1/backup-runs</code></p>
      <p>Returns a JSON array of runs, sorted by <code>received_at</code> descending.</p>
      <h3>Query parameters</h3>
      <ul>
        <li><code>agent_id</code> — filter by exact agent ID</li>
        <li><code>job_name</code> — filter by exact job name</li>
        <li><code>status</code> — filter by status: <code>success</code>, <code>failure</code>, <code>partial</code></li>
        <li><code>since</code> — only include runs with <code>received_at &ge; since</code> (ISO8601)</li>
        <li><code>limit</code> — max results, default 100, max 1000</li>
      </ul>
      <h3>Example</h3>
      <pre>curl -s "https://backup-registry.golder.tech/v1/backup-runs?status=failure&amp;limit=20" \\
  -H "Authorization: Bearer &lt;token&gt;"</pre>
    </div>
  </div>

  <div class="section">
    <div class="section-header"><h2>Get a Backup Run</h2></div>
    <div class="section-content">
      <p><span class="method-badge GET">GET</span><code>/v1/backup-runs/{run_id}</code></p>
      <p>Returns the full run object, or <code>404</code> if not found.</p>
      <pre>curl -s "https://backup-registry.golder.tech/v1/backup-runs/550e8400-e29b-41d4-a716-446655440000" \\
  -H "Authorization: Bearer &lt;token&gt;"</pre>
    </div>
  </div>

  <div class="section">
    <div class="section-header"><h2>Delete a Backup Run</h2></div>
    <div class="section-content">
      <p><span class="method-badge DELETE">DELETE</span><code>/v1/backup-runs/{run_id}</code></p>
      <p>Removes the run record. Returns <code>204 No Content</code>.</p>
      <pre>curl -s -X DELETE "https://backup-registry.golder.tech/v1/backup-runs/550e8400-e29b-41d4-a716-446655440000" \\
  -H "Authorization: Bearer &lt;token&gt;"</pre>
    </div>
  </div>

  <div class="section">
    <div class="section-header"><h2>Prometheus Metrics</h2></div>
    <div class="section-content">
      <p><span class="method-badge GET">GET</span><code>/metrics</code></p>
      <p>Returns Prometheus-format metrics.</p>
      <h3>Backup metrics — latest run per job</h3>
      <ul>
        <li><code>backup_last_run_timestamp_seconds</code>{job_name, agent_id} — Unix timestamp when the latest run ended</li>
        <li><code>backup_last_run_success</code>{job_name, agent_id} — <code>1</code> success, <code>0.5</code> partial, <code>0</code> failure</li>
        <li><code>backup_last_run_duration_seconds</code>{job_name, agent_id} — duration of the latest run</li>
        <li><code>backup_last_run_bytes</code>{job_name, agent_id} — bytes backed up (omitted if not reported)</li>
      </ul>
      <pre>curl -s "https://backup-registry.golder.tech/metrics" \\
  -H "Authorization: Bearer &lt;token&gt;"</pre>
    </div>
  </div>

  <div class="footer">
    <div class="footer-nav">
      <a href="/">Home</a>
      <a href="/v1/backup-runs">API</a>
      <a href="/metrics">Metrics</a>
      <a href="/health">Health</a>
      <a href="/docs">Docs</a>
    </div>
    cloudflare-backup-registry v${VERSION}
  </div>
</body>
</html>`;

  return htmlResponse(html);
}

function handleFavicon(): Response {
  const bytes = Uint8Array.from(atob(FAVICON_B64), c => c.charCodeAt(0));
  return new Response(bytes, {
    headers: { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' },
  });
}

async function handleRunDetail(runId: string, env: Env): Promise<Response> {
  const store = getStore(env);
  const resp = await store.fetch(`http://do/get/${encodeURIComponent(runId)}`);
  if (resp.status === 404) return new Response('Run not found', { status: 404 });
  if (!resp.ok) return new Response('Internal server error', { status: 500 });
  const run: BackupRun = await resp.json();

  const field = (label: string, value: string) =>
    `<div class="field"><span class="field-label">${label}</span><span class="field-value">${value}</span></div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(run.job_name)} — Backup Run</title>
  <link rel="icon" href="/favicon.ico">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #1a1a1a; color: #e0e0e0; max-width: 800px; }
    h1 { margin: 0 0 4px 0; color: #4fc3f7; font-size: 22px; word-break: break-all; }
    .back { color: #4fc3f7; text-decoration: none; font-size: 13px; display: inline-block; margin-bottom: 16px; }
    .back:hover { text-decoration: underline; }
    .card { background: #2d2d2d; border: 1px solid #444; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
    .card h2 { margin: 0 0 14px 0; font-size: 14px; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #444; padding-bottom: 8px; }
    .field { display: flex; padding: 7px 0; border-bottom: 1px solid #333; font-size: 13px; gap: 12px; }
    .field:last-child { border-bottom: none; }
    .field-label { color: #888; min-width: 140px; flex-shrink: 0; }
    .field-value { color: #e0e0e0; word-break: break-all; }
    .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .badge-success { background: #1b5e20; color: #a5d6a7; border: 1px solid #388e3c; }
    .badge-failure { background: #b71c1c; color: #ffcdd2; border: 1px solid #d32f2f; }
    .badge-partial { background: #e65100; color: #ffe0b2; border: 1px solid #f57c00; }
    .badge-encrypted { background: #1b5e20; color: #a5d6a7; border: 1px solid #388e3c; }
    .badge-unencrypted { background: #b71c1c; color: #ffcdd2; border: 1px solid #d32f2f; }
    .error-box { background: #2a1010; border: 1px solid #d32f2f; border-radius: 6px; padding: 12px; color: #e57373; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
    pre { background: #1a1a1a; border: 1px solid #444; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 12px; color: #e0e0e0; margin: 0; }
    .actions { display: flex; gap: 10px; margin-top: 16px; }
    .btn { border-radius: 4px; padding: 7px 16px; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none; border: 1px solid; display: inline-block; }
    .btn-del { background: #2a1010; border-color: #d32f2f; color: #e57373; }
    .btn-del:hover { background: #3a1515; }
    .btn-download-lg { background: #1b3a1b; border-color: #388e3c; color: #81c784; }
    .btn-download-lg:hover { background: #234a23; }
    @media (max-width: 480px) {
      .field { flex-direction: column; gap: 2px; }
      .field-label { min-width: 0; }
    }
  </style>
</head>
<body>
  <a class="back" href="/?job_name=${encodeURIComponent(run.job_name)}">&larr; Back to ${escapeHtml(run.job_name)} history</a>
  <h1>${escapeHtml(run.job_name)}</h1>
  <p style="color:#888;font-size:13px;margin:4px 0 20px 0;">Run ID: ${escapeHtml(run.run_id)}</p>

  <div class="card">
    <h2>Summary</h2>
    ${field('Status', statusBadge(run.status))}
    ${field('Agent', escapeHtml(run.agent_id))}
    ${field('Start time', escapeHtml(formatTime(run.start_time)))}
    ${field('End time', escapeHtml(formatTime(run.end_time)))}
    ${field('Duration', escapeHtml(formatDuration(run.start_time, run.end_time)))}
    ${field('Size', escapeHtml(formatBytes(run.bytes_backed_up)))}
    ${field('Encryption', encBadge(run.encryption_status))}
    ${field('Received at', escapeHtml(formatTime(run.received_at)))}
    ${run.backup_url ? field('Backup URL', `<a href="${escapeHtml(run.backup_url)}" target="_blank" rel="noopener noreferrer" style="color:#4fc3f7;word-break:break-all;">${escapeHtml(run.backup_url)}</a>`) : ''}
  </div>

  ${run.error ? `<div class="card"><h2>Error</h2><div class="error-box">${escapeHtml(run.error)}</div></div>` : ''}

  ${run.metadata ? `<div class="card"><h2>Metadata</h2><pre>${escapeHtml(JSON.stringify(run.metadata, null, 2))}</pre></div>` : ''}

  <div class="actions">
    ${run.backup_url ? `<a class="btn btn-download-lg" href="${escapeHtml(run.backup_url)}" target="_blank" rel="noopener noreferrer">Download backup</a>` : ''}
    <button class="btn btn-del" onclick="delRun(${escapeHtml(JSON.stringify(run.run_id))})">Delete this run</button>
  </div>

  <script>
    async function delRun(runId) {
      if (!confirm('Delete this backup run record?')) return;
      try {
        const r = await fetch('/v1/backup-runs/' + encodeURIComponent(runId), { method: 'DELETE' });
        if (r.ok) window.location.href = '/';
        else alert('Delete failed: ' + r.status);
      } catch(e) { alert('Error: ' + e.message); }
    }
  </script>
</body>
</html>`;

  return htmlResponse(html);
}

function promLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

async function handleMetrics(env: Env): Promise<Response> {
  const store = getStore(env);
  const resp = await store.fetch(`http://do/list?limit=1000`);
  const allRuns: BackupRun[] = await resp.json();

  // Group by job_name, keep the run with the most recent end_time
  const jobMap = new Map<string, BackupRun>();
  for (const run of allRuns) {
    const existing = jobMap.get(run.job_name);
    if (!existing || new Date(run.end_time) > new Date(existing.end_time)) {
      jobMap.set(run.job_name, run);
    }
  }

  const lines: string[] = [];

  lines.push('# HELP backup_last_run_timestamp_seconds Unix timestamp when the latest backup run ended');
  lines.push('# TYPE backup_last_run_timestamp_seconds gauge');
  for (const run of jobMap.values()) {
    const ts = Math.floor(new Date(run.end_time).getTime() / 1000);
    lines.push(`backup_last_run_timestamp_seconds{job_name="${promLabel(run.job_name)}",agent_id="${promLabel(run.agent_id)}"} ${ts}`);
  }

  lines.push('# HELP backup_last_run_success Whether the latest backup run succeeded (1=success, 0=failure, 0.5=partial)');
  lines.push('# TYPE backup_last_run_success gauge');
  for (const run of jobMap.values()) {
    const v = run.status === 'success' ? 1 : run.status === 'partial' ? 0.5 : 0;
    lines.push(`backup_last_run_success{job_name="${promLabel(run.job_name)}",agent_id="${promLabel(run.agent_id)}"} ${v}`);
  }

  lines.push('# HELP backup_last_run_duration_seconds Duration of the latest backup run in seconds');
  lines.push('# TYPE backup_last_run_duration_seconds gauge');
  for (const run of jobMap.values()) {
    const ms = new Date(run.end_time).getTime() - new Date(run.start_time).getTime();
    if (!isNaN(ms) && ms >= 0) {
      lines.push(`backup_last_run_duration_seconds{job_name="${promLabel(run.job_name)}",agent_id="${promLabel(run.agent_id)}"} ${(ms / 1000).toFixed(3)}`);
    }
  }

  lines.push('# HELP backup_last_run_bytes Bytes backed up in the latest run');
  lines.push('# TYPE backup_last_run_bytes gauge');
  for (const run of jobMap.values()) {
    if (run.bytes_backed_up !== undefined) {
      lines.push(`backup_last_run_bytes{job_name="${promLabel(run.job_name)}",agent_id="${promLabel(run.agent_id)}"} ${run.bytes_backed_up}`);
    }
  }

  lines.push('');
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
  });
}

async function handleHealth(env: Env): Promise<Response> {
  return Response.json({
    status: 'healthy',
    version: VERSION,
    timestamp: new Date().toISOString(),
  });
}

async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    console.error('OAuth error:', error, url.searchParams.get('error_description'));
    return new Response(`OAuth2 error: ${error}`, { status: 400 });
  }

  if (!code) {
    console.error('Missing authorization code');
    return new Response('Missing authorization code', { status: 400 });
  }

  const config = getAuthConfig(env);
  if (!config.oauth2) {
    console.error('OAuth2 not configured');
    return new Response('OAuth2 not configured', { status: 500 });
  }

  const redirectUri = `${url.origin}/oauth/callback`;

  try {
    const tokenResp = await fetch(config.oauth2.tokenEndpoint, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Host': new URL(config.oauth2.tokenEndpoint).host,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: config.oauth2.clientId,
        client_secret: config.oauth2.clientSecret,
      }),
    });

    if (!tokenResp.ok) {
      const err = await tokenResp.text();
      console.error('Token exchange failed:', tokenResp.status, err);
      return new Response(`Token exchange failed (${tokenResp.status}): ${err}`, { status: 400 });
    }

    const tokens = await tokenResp.json() as { access_token: string; id_token?: string; refresh_token?: string; expires_in?: number };
    const redirectPath = state ? atob(decodeURIComponent(state)) : '/';

    const sessionTokens = {
      accessToken: tokens.id_token || tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + ((tokens.expires_in || 300) * 1000) - 300000,
    };
    return createSessionCookie(sessionTokens, redirectPath);
  } catch (err) {
    console.error('OAuth2 token exchange error:', err);
    return new Response('Token exchange failed', { status: 500 });
  }
}

async function handleLogout(): Promise<Response> {
  return clearSessionCookie();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const withAuth = async (handler: () => Promise<Response>): Promise<Response> => {
      const config = getAuthConfig(env);
      const result = await authenticate(request, env, config);
      if (!result.authenticated) {
        if (result.redirect) return unauthorized(config, result.redirect);
        return unauthorized(config);
      }
      return handler();
    };

    try {
      if (path === '/oauth/callback') {
        return handleOAuthCallback(request, env);
      } else if (path === '/logout') {
        return handleLogout();
      }

      if (path === '/health') return withAuth(() => handleHealth(env));
      if (path === '/favicon.ico') return handleFavicon();

      if ((path === '/' || path === '') && method === 'GET') return withAuth(() => handleUI(request, env, getSiteName(request, env), env.DOCS_URL || ''));
      if (path === '/docs' && method === 'GET') return withAuth(() => handleDocs());
      if (path === '/metrics' && method === 'GET') return withAuth(() => handleMetrics(env));

      if (path.startsWith('/run/') && method === 'GET') {
        const runId = decodeURIComponent(path.slice('/run/'.length));
        if (runId) return withAuth(() => handleRunDetail(runId, env));
      }

      if (path === '/v1/backup-runs') {
        if (method === 'POST') return withAuth(() => handleSubmit(request, env));
        if (method === 'GET') return withAuth(() => handleList(request, env));
        return new Response('Method Not Allowed', { status: 405 });
      }

      if (path.startsWith('/v1/backup-runs/')) {
        const runId = decodeURIComponent(path.slice('/v1/backup-runs/'.length));
        if (!runId) return new Response('Missing run_id', { status: 400 });
        if (method === 'GET') return withAuth(() => handleGetRun(runId, env));
        if (method === 'DELETE') return withAuth(() => handleDeleteRun(runId, env));
        return new Response('Method Not Allowed', { status: 405 });
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error('Unhandled error:', err instanceof Error ? err.stack : String(err));
      return new Response('Internal server error', { status: 500 });
    }
  },
};

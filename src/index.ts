import { BackupRegistry, Env, BackupRun, BackupStatus, EncryptionStatus, MAX_BODY_SIZE } from './durable-object';
import { authenticate, unauthorized } from './auth';

export { BackupRegistry };

const VERSION = '0.1.0';
const VALID_STATUSES: BackupStatus[] = ['success', 'failure', 'partial'];
const VALID_ENC_STATUSES: EncryptionStatus[] = ['encrypted', 'unencrypted', 'partial', 'failed'];

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
  const i = Math.floor(Math.log(bytes) / Math.log(k));
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
      metadata: d.metadata as Record<string, unknown> | undefined,
    },
  };
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return Response.json({ error: 'Request body too large' }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
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
  for (const [key, val] of url.searchParams) {
    params.set(key, val);
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

async function handleUI(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const filterAgent = url.searchParams.get('agent_id') || '';
  const filterJob = url.searchParams.get('job_name') || '';
  const filterStatus = url.searchParams.get('status') || '';
  const limit = url.searchParams.get('limit') || '100';

  const params = new URLSearchParams();
  if (filterAgent) params.set('agent_id', filterAgent);
  if (filterJob) params.set('job_name', filterJob);
  if (filterStatus) params.set('status', filterStatus);
  params.set('limit', limit);

  const store = getStore(env);
  const resp = await store.fetch(`http://do/list?${params}`);
  const runs: BackupRun[] = await resp.json();

  const totalSuccess = runs.filter(r => r.status === 'success').length;
  const totalFailure = runs.filter(r => r.status === 'failure').length;
  const totalPartial = runs.filter(r => r.status === 'partial').length;

  const statusOptions = ['', 'success', 'failure', 'partial']
    .map(s => `<option value="${s}"${filterStatus === s ? ' selected' : ''}>${s || 'All statuses'}</option>`)
    .join('');

  let rows = '';
  if (runs.length === 0) {
    rows = '<tr><td colspan="9" class="empty">No backup runs found.</td></tr>';
  } else {
    for (const run of runs) {
      const errCell = run.error
        ? `<span class="error-text" title="${escapeHtml(run.error)}">${escapeHtml(run.error.substring(0, 60))}${run.error.length > 60 ? '…' : ''}</span>`
        : '—';
      rows += `<tr>
        <td><strong>${escapeHtml(run.job_name)}</strong></td>
        <td>${escapeHtml(run.agent_id)}</td>
        <td>${statusBadge(run.status)}</td>
        <td>${escapeHtml(formatTime(run.start_time))}</td>
        <td>${escapeHtml(formatDuration(run.start_time, run.end_time))}</td>
        <td>${escapeHtml(formatBytes(run.bytes_backed_up))}</td>
        <td>${encBadge(run.encryption_status)}</td>
        <td>${errCell}</td>
        <td class="actions">
          <button class="btn-view" onclick="viewRun(${JSON.stringify(run.run_id)})">View</button>
          <button class="btn-del" onclick="delRun(${JSON.stringify(run.run_id)})">Delete</button>
        </td>
      </tr>`;
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Backup Registry</title>
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
    .actions button { background: #444; border: 1px solid #666; border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 12px; color: #e0e0e0; margin-left: 4px; }
    .actions button:hover { background: #555; }
    .btn-del:hover { color: #e57373; border-color: #e57373; }
    .btn-view:hover { color: #4fc3f7; border-color: #4fc3f7; }
    .footer { margin-top: 20px; font-size: 12px; color: #888; text-align: center; padding: 16px; border-top: 1px solid #444; }
    .footer-nav { margin-bottom: 12px; display: flex; justify-content: center; gap: 16px; flex-wrap: wrap; }
    .footer-nav a { color: #4fc3f7; text-decoration: none; font-size: 13px; padding: 4px 8px; border-radius: 4px; }
    .footer-nav a:hover { background-color: #333; }
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; align-items: center; justify-content: center; }
    .modal-overlay.active { display: flex; }
    .modal { background: #2d2d2d; border: 1px solid #555; border-radius: 8px; padding: 24px; max-width: 680px; width: 90%; max-height: 80vh; overflow-y: auto; }
    .modal h2 { margin: 0 0 16px 0; color: #4fc3f7; font-size: 18px; }
    .modal pre { background: #1a1a1a; border: 1px solid #444; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 12px; color: #e0e0e0; }
    .modal-close { float: right; background: #444; border: 1px solid #666; border-radius: 4px; padding: 4px 12px; cursor: pointer; color: #e0e0e0; font-size: 13px; }
    .modal-close:hover { background: #555; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>Backup Registry</h1>
      <p>Backup run reports from registered agents</p>
    </div>
    <div>
      <a href="/docs" style="color: #4fc3f7; text-decoration: none; font-size: 14px;">API Docs</a>
    </div>
  </div>

  <div class="stats">
    <div class="stat-card"><div class="count count-total">${runs.length}</div><div class="label">Shown</div></div>
    <div class="stat-card"><div class="count count-success">${totalSuccess}</div><div class="label">Success</div></div>
    <div class="stat-card"><div class="count count-failure">${totalFailure}</div><div class="label">Failure</div></div>
    <div class="stat-card"><div class="count count-partial">${totalPartial}</div><div class="label">Partial</div></div>
  </div>

  <form class="filter-form" method="get" action="/">
    <label>Agent ID <input type="text" name="agent_id" value="${escapeHtml(filterAgent)}" placeholder="any"></label>
    <label>Job Name <input type="text" name="job_name" value="${escapeHtml(filterJob)}" placeholder="any"></label>
    <label>Status <select name="status">${statusOptions}</select></label>
    <label>Limit <input type="number" name="limit" value="${escapeHtml(limit)}" min="1" max="1000" style="min-width:80px;"></label>
    <button type="submit">Filter</button>
    ${filterAgent || filterJob || filterStatus ? '<a href="/">Clear</a>' : ''}
  </form>

  <table>
    <thead>
      <tr>
        <th>Job</th>
        <th>Agent</th>
        <th>Status</th>
        <th>Start Time</th>
        <th>Duration</th>
        <th>Size</th>
        <th>Encryption</th>
        <th>Error</th>
        <th></th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="modal-overlay" id="modal">
    <div class="modal">
      <button class="modal-close" onclick="closeModal()">Close</button>
      <h2>Run Details</h2>
      <pre id="modal-content"></pre>
    </div>
  </div>

  <script>
    function viewRun(runId) {
      fetch('/v1/backup-runs/' + encodeURIComponent(runId))
        .then(r => r.json())
        .then(data => {
          document.getElementById('modal-content').textContent = JSON.stringify(data, null, 2);
          document.getElementById('modal').classList.add('active');
        })
        .catch(e => alert('Error: ' + e.message));
    }
    function closeModal() {
      document.getElementById('modal').classList.remove('active');
    }
    document.getElementById('modal').addEventListener('click', e => {
      if (e.target === document.getElementById('modal')) closeModal();
    });
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
      <a href="/health">Health</a>
      <a href="/docs">Docs</a>
    </div>
    cloudflare-backup-registry v${VERSION}
  </div>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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

  <div class="footer">
    <div class="footer-nav">
      <a href="/">Home</a>
      <a href="/v1/backup-runs">API</a>
      <a href="/health">Health</a>
      <a href="/docs">Docs</a>
    </div>
    cloudflare-backup-registry v${VERSION}
  </div>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleHealth(request: Request, env: Env): Promise<Response> {
  if (!(await authenticate(request, env))) return unauthorized(env);
  return Response.json({
    status: 'healthy',
    version: VERSION,
    timestamp: new Date().toISOString(),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === '/health') return handleHealth(request, env);

      if (!(await authenticate(request, env))) return unauthorized(env);

      if ((path === '/' || path === '') && method === 'GET') return handleUI(request, env);
      if (path === '/docs' && method === 'GET') return handleDocs();

      if (path === '/v1/backup-runs') {
        if (method === 'POST') return handleSubmit(request, env);
        if (method === 'GET') return handleList(request, env);
        return new Response('Method Not Allowed', { status: 405 });
      }

      if (path.startsWith('/v1/backup-runs/')) {
        const runId = decodeURIComponent(path.slice('/v1/backup-runs/'.length));
        if (!runId) return new Response('Missing run_id', { status: 400 });
        if (method === 'GET') return handleGetRun(runId, env);
        if (method === 'DELETE') return handleDeleteRun(runId, env);
        return new Response('Method Not Allowed', { status: 405 });
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Internal Server Error: ${message}`, { status: 500 });
    }
  },
};

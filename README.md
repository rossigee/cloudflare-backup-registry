# cloudflare-backup-registry

A Cloudflare Workers app for collecting and displaying backup run reports submitted by backup agents. Runs entirely on Cloudflare's edge with zero infrastructure — state is held in a Durable Object.

![Backup Registry UI](docs/screenshot.png)

## Features

- **`POST /v1/backup-runs`** — agents submit structured backup reports
- **Web UI** — dark-theme dashboard with status/encryption badges, duration, size, error display, and per-row delete
- **Filtering** — filter by agent ID, job name, and status via the UI or API query params
- **Authentication** — Basic auth, API tokens, or JWT/OIDC; open if unconfigured
- **No infrastructure** — Durable Object storage, no external database

## Quick start

```bash
npm install
npm run dev         # wrangler dev on http://localhost:8787
npm test            # vitest (31 tests)
npm run typecheck   # tsc --noEmit
```

Seed some test data:

```bash
curl -X POST http://localhost:8787/v1/backup-runs \
  -H "Content-Type: application/json" \
  -d '{
    "run_id": "550e8400-e29b-41d4-a716-446655440000",
    "job_name": "postgres-daily",
    "agent_id": "agent-db-01",
    "start_time": "2026-05-12T02:00:00Z",
    "end_time": "2026-05-12T02:04:33Z",
    "status": "success",
    "bytes_backed_up": 1073741824,
    "encrypted": true,
    "encryption_status": "encrypted"
  }'
```

## Payload schema

`POST /v1/backup-runs` — `Content-Type: application/json`

| Field | Type | Required | Notes |
|---|---|---|---|
| `run_id` | string | ✓ | Unique run identifier (UUID recommended). Re-submitting the same `run_id` overwrites. |
| `job_name` | string | ✓ | |
| `agent_id` | string | ✓ | |
| `start_time` | string | ✓ | ISO 8601 |
| `end_time` | string | ✓ | ISO 8601 |
| `status` | string | ✓ | `success` \| `failure` \| `partial` |
| `bytes_backed_up` | number | — | Non-negative |
| `encrypted` | boolean | — | |
| `encryption_status` | string | — | `encrypted` \| `unencrypted` \| `partial` \| `failed` |
| `error` | string \| null | — | Error message if status is not success |
| `metadata` | object | — | Arbitrary key/value pairs |

The server adds `received_at` (ISO 8601) on ingestion.

Returns `201 Created` with the stored object, or `400 Bad Request` with `{"error": "..."}` on validation failure.

## API reference

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/backup-runs` | Submit a backup run |
| `GET` | `/v1/backup-runs` | List runs (newest first) |
| `GET` | `/v1/backup-runs/:run_id` | Get a specific run |
| `DELETE` | `/v1/backup-runs/:run_id` | Delete a run |
| `GET` | `/` | Web UI |
| `GET` | `/docs` | API documentation |
| `GET` | `/health` | Health check |

### List query parameters

| Param | Description |
|---|---|
| `agent_id` | Exact match on agent ID |
| `job_name` | Exact match on job name |
| `status` | `success`, `failure`, or `partial` |
| `since` | ISO 8601 — only runs with `received_at ≥ since` |
| `limit` | Max results, default `100`, max `1000` |

## Authentication

Three methods are supported, checked in order. If none are configured, all requests are accepted (suitable for development).

| Method | Use case |
|---|---|
| **API token** ⭐ | Backup agents (recommended) |
| JWT/OIDC | Web UI login (requires Keycloak client setup) |
| Basic auth | Admin UI/API access (development) |

### API tokens for backup agents ⭐ (recommended)

API tokens are the simplest and most secure method for automated backup scripts.

**Generate tokens** — already set up in Cloudflare Workers for each tenant:
- golder: `tenants/rossgolderltd/backups-registry/api-key` in Vault
- wardle: `tenants/wardle/backups-registry/api-key` in Vault
- timewarp: `tenants/timewarp/backups-registry/api-key` in Vault

**Use in backup scripts:**

```bash
curl -X POST https://backups.golder.tech/v1/backup-runs \
  -H "X-API-Key: <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "run_id": "550e8400-e29b-41d4-a716-446655440000",
    "job_name": "postgres-daily",
    "agent_id": "agent-db-01",
    "start_time": "2026-05-12T02:00:00Z",
    "end_time": "2026-05-12T02:04:33Z",
    "status": "success"
  }'
```

Or with Bearer token:

```bash
curl -X POST https://backups.golder.tech/v1/backup-runs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

### JWT/OIDC (Web UI login)

For the web UI, configure JWT/OIDC to enable single sign-on via Keycloak. This requires:

1. **Create Keycloak OIDC client** in each realm:
   - Client ID: `backups-registry`
   - Access Type: `confidential`
   - Valid Redirect URIs: `https://backups.<domain>/oauth/callback`
   
2. **Store credentials in Vault** (example for golder):
   ```bash
   vault kv put tenants/rossgolderltd/keycloak/clients/backups-registry \
     client_id=backups-registry \
     client_secret=<keycloak-generated-secret>
   ```

3. **Set Cloudflare secrets**:
   ```bash
   npx wrangler secret put OIDC_CLIENT_SECRET --env golder
   ```

See [Keycloak setup guide](docs/keycloak-setup.md) (TODO).

### Basic auth (admin access, development only)

```bash
npx wrangler secret put AUTH_USER
# Enter: admin

npx wrangler secret put AUTH_PASS
# Enter: your-secure-password
```

## Setup

### Local environment (.env)

Create `.env` from Vault secrets (requires Vault access):

```bash
vault login -method=oidc
./.env.sh golder > .env      # or: wardle, timewarp
```

This pulls live credentials from Vault for the specified tenant:
- `infrastructure/cloudflare` → Cloudflare API token
- `tenants/{golder,wardle,timewarp}/keycloak/clients/backups-registry` → OIDC client secret

Each tenant has separate OIDC credentials. `.env` is gitignored — never commit it. Always regenerate from Vault for local development.

## Deploy

```bash
npm run deploy
```

Requires `CLOUDFLARE_API_TOKEN` in `.env` or set in environment, or run `npx wrangler login` first.

## Configuration

`wrangler.toml` — update the custom domain to match your zone:

```toml
routes = [
  { pattern = "backup-registry.example.com", custom_domain = true }
]
```

## Agent example (shell)

```bash
#!/usr/bin/env bash
# Submit a backup run report after your backup completes.
# Requires: BACKUP_REGISTRY_URL and BACKUP_REGISTRY_TOKEN environment variables

curl -sf -X POST "${BACKUP_REGISTRY_URL}/v1/backup-runs" \
  -H "X-API-Key: ${BACKUP_REGISTRY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg run_id "$(uuidgen)" \
    --arg job_name "${JOB_NAME}" \
    --arg agent_id "$(hostname)" \
    --arg start_time "${START_TIME}" \
    --arg end_time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg status "${STATUS}" \
    --argjson bytes "${BYTES_WRITTEN:-0}" \
    '{run_id:$run_id,job_name:$job_name,agent_id:$agent_id,start_time:$start_time,end_time:$end_time,status:$status,bytes_backed_up:$bytes}'
  )"
```

**Usage:**

```bash
export BACKUP_REGISTRY_URL="https://backups.golder.tech"
export BACKUP_REGISTRY_TOKEN="<api-token-from-vault>"
export JOB_NAME="postgres-daily"
export START_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export STATUS="success"
./agent-submit-backup.sh
```

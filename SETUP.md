# Setup Guide

This guide walks through setting up the Backup Registry for your organization.

## Prerequisites

- Node.js 18+
- Cloudflare account with Workers enabled
- Vault access (if using Vault for secrets)
- A domain for the backup registry

## Step 1: Create deployment configuration

Choose a deployment name (e.g., `production`, `staging`) and create configuration files.

### Create sites/production.env

Replace the placeholders with your actual values:

```bash
# Vault tenant path where your secrets are stored
VAULT_TENANT=my-organization-id

# Your Keycloak/OIDC issuer
JWT_ISSUER=https://auth.example.com/auth/realms/my-realm

# Domain where you'll deploy the registry
BASE_URL=https://backups.example.com

# Your Cloudflare account ID (find in https://dash.cloudflare.com/)
CLOUDFLARE_ACCOUNT_ID=abc123def456abc123def456abc123de
```

### Create sites/wrangler.production.toml

Replace the placeholders with your values:

```toml
# Site-specific config for production
# DO NOT COMMIT - Add to .gitignore

account_id = "abc123def456abc123def456abc123de"
routes = [{ pattern = "backups.example.com", custom_domain = true }]
vars = { 
  SITE_NAME = "My Company Backups", 
  JWT_ISSUER = "https://auth.example.com/auth/realms/my-realm", 
  JWT_AUDIENCE = "backups-registry", 
  BASE_URL = "https://backups.example.com" 
}

[[durable_objects.bindings]]
name = "BACKUP_STORE"
class_name = "BackupRegistry"
```

### Add .gitignore entries

Ensure these files are never committed:

```bash
# In .gitignore, add or verify:
sites/*.env
sites/wrangler.*.toml
.env
```

## Step 2: Set up Vault secrets (if using Vault)

Store your Cloudflare API token and OIDC credentials:

```bash
# Cloudflare API token (shared across deployments)
vault kv put infrastructure/cloudflare \
  api_token=your-cloudflare-api-token

# OIDC client secret for this deployment
vault kv put tenants/my-organization-id/keycloak/clients/backups-registry \
  client_id=backups-registry \
  client_secret=your-keycloak-client-secret
```

## Step 3: Source environment for local development

Generate `.env` file from Vault:

```bash
vault login -method=oidc
source .env.sh production
```

This creates an `.env` file (gitignored) with credentials pulled from Vault. **Never commit `.env`.**

## Step 4: Update package.json scripts

If you have multiple deployments, add scripts for each:

```json
"scripts": {
  "deploy:production": "wrangler deploy --env production -c sites/wrangler.production.toml",
  "deploy:staging": "wrangler deploy --env staging -c sites/wrangler.staging.toml"
}
```

## Step 5: Deploy

```bash
# Source environment variables (one-time per shell session)
source .env.sh production

# Deploy the application
npm run deploy:production
```

After deployment, verify:
- Visit `https://backups.example.com/` (should show UI)
- Visit `https://backups.example.com/health` (should return 200)

## Step 6: Set up OIDC (optional, for web UI login)

If you want users to log in via single sign-on:

1. Create an OIDC client in your Keycloak realm:
   - Client ID: `backups-registry`
   - Access Type: `confidential`
   - Valid Redirect URIs: `https://backups.example.com/oauth/callback`

2. Store the client secret in Vault (done in Step 2)

3. Redeploy with OIDC_CLIENT_SECRET set:
   ```bash
   source .env.sh production
   npx wrangler secret put OIDC_CLIENT_SECRET --env production
   # Paste the Keycloak client secret
   npm run deploy:production
   ```

## Step 7: Configure backup agents

Provide agents with an API token. Store it in your secret management system:

```bash
vault kv put tenants/my-organization-id/backups-registry/api-key \
  api_key=your-generated-token
```

Agents use it like this:

```bash
curl -X POST https://backups.example.com/v1/backup-runs \
  -H "X-API-Key: your-generated-token" \
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

## Troubleshooting

### `.env.sh production` fails

- Ensure `sites/production.env` exists
- Run `vault login -method=oidc` first
- Check Vault is reachable: `vault status`

### Deployment fails

- Verify `CLOUDFLARE_API_TOKEN` is set: `echo $CLOUDFLARE_API_TOKEN`
- Check account ID matches your Cloudflare account
- Verify domain is added to your Cloudflare zone

### OIDC login not working

- Verify Keycloak realm and client ID match your config
- Check redirect URI is exactly `https://backups.example.com/oauth/callback`
- Redeploy after setting `OIDC_CLIENT_SECRET`

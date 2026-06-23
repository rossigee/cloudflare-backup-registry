#!/bin/bash
# Generate .env from Vault secrets
# Requires: vault login already authenticated
# Usage: ./.env.sh > .env

set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-https://vault.bankrut.lan}"
export VAULT_ADDR

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# Check Vault connectivity
vault status > /dev/null 2>&1 || die "Cannot reach Vault at $VAULT_ADDR. Run: vault login -method=oidc"

echo "# Cloudflare API credentials for deployment"
CLOUDFLARE_API_TOKEN=$(vault kv get -field=api_token infrastructure/cloudflare 2>/dev/null || die "Cannot read infrastructure/cloudflare from Vault")
echo "CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN"

# Default Cloudflare account for golder (from wrangler.toml)
echo "CLOUDFLARE_ACCOUNT_ID=c1b74f148aee28025816e104a92622c5"

echo ""
echo "# OAuth2/OIDC:"

# Golder tenant OIDC config
echo "JWT_ISSUER=https://sso.golder.tech/auth/realms/ROSSGolderLtd"
echo "JWT_AUDIENCE=backups-registry"

GOLDER_OIDC_SECRET=$(vault kv get -format=json tenants/rossgolderltd/keycloak/clients/backups-registry 2>/dev/null | jq -r '.data.data.client_secret' || die "Cannot read tenants/rossgolderltd/keycloak/clients/backups-registry from Vault")
echo "OIDC_CLIENT_SECRET=$GOLDER_OIDC_SECRET"

echo "BASE_URL=https://backups.golder.tech"

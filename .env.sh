#!/bin/bash
# Generate .env from Vault secrets for a specific tenant
# Requires: vault login already authenticated
# Usage: source .env.sh [golder|wardle|timewarp]

set -euo pipefail

TENANT="${1:-golder}"
SITE_DIR="$(dirname "$0")/sites"
VAULT_ADDR="${VAULT_ADDR:-https://vault.bankrut.lan}"
export VAULT_ADDR

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# Check site config exists
SITE_CONFIG="$SITE_DIR/$TENANT.env"
if [[ ! -f "$SITE_CONFIG" ]]; then
  die "Unknown tenant: $TENANT. Valid: golder, wardle, timewarp. Create $SITE_CONFIG first."
fi

# Source site-specific config (non-secret)
source "$SITE_CONFIG"

# Check Vault connectivity
vault status > /dev/null 2>&1 || die "Cannot reach Vault at $VAULT_ADDR. Run: vault login -method=oidc"

echo "# Cloudflare API credentials for deployment"
CLOUDFLARE_API_TOKEN=$(vault kv get -field=api_token infrastructure/cloudflare 2>/dev/null || die "Cannot read infrastructure/cloudflare from Vault")
echo "CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN"
echo "CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID"

echo ""
echo "# OAuth2/OIDC (tenant: $TENANT):"
echo "JWT_ISSUER=$JWT_ISSUER"
echo "JWT_AUDIENCE=backups-registry"

OIDC_SECRET=$(vault kv get -format=json "tenants/$VAULT_TENANT/keycloak/clients/backups-registry" 2>/dev/null | jq -r '.data.data.client_secret' || die "Cannot read tenants/$VAULT_TENANT/keycloak/clients/backups-registry from Vault")
echo "OIDC_CLIENT_SECRET=$OIDC_SECRET"

echo "BASE_URL=$BASE_URL"
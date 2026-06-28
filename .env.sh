#!/bin/bash
# Generate .env from Vault secrets for a specific deployment
# Requires: vault login already authenticated
# Usage: source .env.sh <deployment-name>

set -euo pipefail

DEPLOYMENT="${1:?deployment name required (e.g., production, staging)}"
SITE_DIR="$(dirname "$0")/sites"
VAULT_ADDR="${VAULT_ADDR:-https://vault.bankrut.lan}"
export VAULT_ADDR

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# Check site config exists
SITE_CONFIG="$SITE_DIR/$DEPLOYMENT.env"
if [[ ! -f "$SITE_CONFIG" ]]; then
  die "Config not found: $SITE_CONFIG. Create it first with your deployment settings."
fi

# Source deployment-specific config (non-secret)
source "$SITE_CONFIG"

# Check Vault connectivity
vault status > /dev/null 2>&1 || die "Cannot reach Vault at $VAULT_ADDR. Run: vault login -method=oidc"

echo "# Cloudflare API credentials for deployment"
CLOUDFLARE_API_TOKEN=$(vault kv get -field=api_token infrastructure/cloudflare 2>/dev/null || die "Cannot read infrastructure/cloudflare from Vault")
echo "CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN"
echo "CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID"

echo ""
echo "# OAuth2/OIDC (deployment: $DEPLOYMENT):"
echo "JWT_ISSUER=$JWT_ISSUER"
echo "JWT_AUDIENCE=backups-registry"

OIDC_SECRET=$(vault kv get -format=json "tenants/$VAULT_TENANT/keycloak/clients/backups-registry" 2>/dev/null | jq -r '.data.data.client_secret' || die "Cannot read OIDC secret from Vault at tenants/$VAULT_TENANT/keycloak/clients/backups-registry")
echo "OIDC_CLIENT_SECRET=$OIDC_SECRET"

echo "BASE_URL=$BASE_URL"
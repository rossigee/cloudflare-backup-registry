#!/bin/bash
# Generate .env from Vault secrets for a specific tenant
# Requires: vault login already authenticated
# Usage: ./.env.sh [golder|wardle|timewarp] > .env

set -euo pipefail

TENANT="${1:-golder}"
VAULT_ADDR="${VAULT_ADDR:-https://vault.bankrut.lan}"
export VAULT_ADDR

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# Tenant config
case "$TENANT" in
  golder)
    VAULT_TENANT="rossgolderltd"
    JWT_ISSUER="https://sso.golder.tech/auth/realms/ROSSGolderLtd"
    BASE_URL="https://backups.golder.tech"
    CLOUDFLARE_ACCOUNT_ID="c1b74f148aee28025816e104a92622c5"
    ;;
  wardle)
    VAULT_TENANT="wardle"
    JWT_ISSUER="https://sso.wardle.online/auth/realms/Wardle"
    BASE_URL="https://backups.wardle.online"
    CLOUDFLARE_ACCOUNT_ID="c319c02aa39a98bfaaad068b83c0b179"
    ;;
  timewarp)
    VAULT_TENANT="timewarp"
    JWT_ISSUER="https://sso.timewarp.ws/auth/realms/Timewarp"
    BASE_URL="https://backups.timewarp.ws"
    CLOUDFLARE_ACCOUNT_ID="bd32abceb7ddba1b066a11732ae38c2f"
    ;;
  *)
    die "Unknown tenant: $TENANT. Valid: golder, wardle, timewarp"
    ;;
esac

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

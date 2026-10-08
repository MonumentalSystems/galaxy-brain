#!/usr/bin/env bash
set -Eeuo pipefail

action="${1:-}"
artifact_dir="${MIGRATION_ARTIFACT_DIR:-}"
source_mode="${MIGRATION_SOURCE_MODE:-neon}"

case "$source_mode" in
  neon|fresh-auth) ;;
  *)
    echo "MIGRATION_SOURCE_MODE must be neon or fresh-auth" >&2
    exit 2
    ;;
esac

if [[ -z "$artifact_dir" || "$artifact_dir" == "/" ]]; then
  echo "MIGRATION_ARTIFACT_DIR must be a dedicated, explicit directory" >&2
  exit 2
fi
case "$action" in
  export)
    required_variables=(GALAXY_API_SOURCE_DATABASE_URL)
    if [[ "$source_mode" == "neon" ]]; then
      required_variables+=(NEON_SOURCE_DATABASE_URL)
    fi
    ;;
  restore)
    required_variables=(GALAXY_TARGET_DATABASE_URL)
    ;;
  verify)
    required_variables=(GALAXY_API_SOURCE_DATABASE_URL GALAXY_TARGET_DATABASE_URL)
    if [[ "$source_mode" == "neon" ]]; then
      required_variables+=(NEON_SOURCE_DATABASE_URL)
    fi
    ;;
  *)
    echo "Usage: scripts/transfer-database.sh {export|restore|verify}" >&2
    exit 2
    ;;
esac

for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" || "${!variable_name}" == *$'\n'* ]]; then
    echo "$variable_name must be set to a single-line PostgreSQL URL" >&2
    exit 2
  fi
done

mkdir -p "$artifact_dir"
chmod 700 "$artifact_dir"
service_file="$(mktemp "$artifact_dir/pg-service.XXXXXX")"
password_file="$(mktemp "$artifact_dir/pg-pass.XXXXXX")"
chmod 600 "$service_file"
chmod 600 "$password_file"
cleanup() {
  rm -f -- "$service_file" "$password_file"
}
trap cleanup EXIT

export PGSERVICEFILE="$service_file"
export PGPASSFILE="$password_file"
node scripts/write-pg-service.mjs

case "$action" in
  export)
    printf '%s\n' "$source_mode" > "$artifact_dir/MIGRATION-MODE"
    checksum_files=("MIGRATION-MODE")
    if [[ "$source_mode" == "neon" ]]; then
      pg_dump --dbname=service=neon_source --format=custom --compress=9 \
        --no-owner --no-acl --table='public.app_*' \
        --file="$artifact_dir/neon-app.dump"
      pg_restore --list "$artifact_dir/neon-app.dump" > "$artifact_dir/neon-app.contents"
      checksum_files+=("neon-app.dump")
    fi
    pg_dump --dbname=service=api_source --format=custom --compress=9 \
      --no-owner --no-acl --table='public.gb_*' \
      --file="$artifact_dir/galaxy-api.dump"
    pg_restore --list "$artifact_dir/galaxy-api.dump" > "$artifact_dir/galaxy-api.contents"
    checksum_files+=("galaxy-api.dump")
    (
      cd "$artifact_dir"
      sha256sum "${checksum_files[@]}" > SHA256SUMS
    )
    echo "Export complete in $source_mode mode. Preserve the dump files and SHA256SUMS together."
    ;;
  restore)
    if [[ "${RESTORE_CONFIRMATION:-}" != "restore-to-empty-galaxy-target" ]]; then
      echo "Set RESTORE_CONFIRMATION=restore-to-empty-galaxy-target after independently confirming the target." >&2
      exit 2
    fi
    (
      cd "$artifact_dir"
      sha256sum --check SHA256SUMS
    )
    artifact_mode="$(<"$artifact_dir/MIGRATION-MODE")"
    if [[ "$artifact_mode" != "$source_mode" ]]; then
      echo "Artifact mode is $artifact_mode but MIGRATION_SOURCE_MODE is $source_mode; refusing restore." >&2
      exit 1
    fi
    existing_tables="$(psql service=target --tuples-only --no-align --command \
      "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'app\\_%' ESCAPE '\\' OR tablename LIKE 'gb\\_%' ESCAPE '\\')")"
    if [[ "$existing_tables" != "0" ]]; then
      echo "Target already contains $existing_tables Galaxy Brain tables; refusing restore." >&2
      exit 1
    fi
    psql service=target --set=ON_ERROR_STOP=1 --file=db/migrations/001_extensions.sql
    if [[ "$source_mode" == "neon" ]]; then
      pg_restore --dbname=service=target --no-owner --no-acl --exit-on-error \
        "$artifact_dir/neon-app.dump"
    fi
    pg_restore --dbname=service=target --no-owner --no-acl --exit-on-error \
      "$artifact_dir/galaxy-api.dump"
    DATABASE_MIGRATION_URL="$GALAXY_TARGET_DATABASE_URL" node scripts/db-migrate.mjs
    echo "Restore and ordered migrations complete in $source_mode mode. Run verify before cutover."
    ;;
  verify)
    DATABASE_VERIFY_URL="$GALAXY_TARGET_DATABASE_URL" node scripts/db-verify.mjs
    MIGRATION_SOURCE_MODE="$source_mode" node scripts/db-compare.mjs
    ;;
esac

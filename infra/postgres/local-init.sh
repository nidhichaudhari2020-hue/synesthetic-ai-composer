#!/bin/sh
set -eu
: "${APP_DB_PASSWORD:?Set APP_DB_PASSWORD}"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f /opt/auralis/schema.sql
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1 <<'SQL'
\getenv app_password APP_DB_PASSWORD
SELECT format('ALTER ROLE app_runtime PASSWORD %L', :'app_password') \gexec
SQL

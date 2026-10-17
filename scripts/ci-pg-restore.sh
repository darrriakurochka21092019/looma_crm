#!/bin/sh
set -eu
exec docker exec -i "$PG_CONTAINER" pg_restore -U "$PGUSER" "$@"

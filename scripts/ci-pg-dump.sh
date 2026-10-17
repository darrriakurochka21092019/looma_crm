#!/bin/sh
set -eu
exec docker exec -i "$PG_CONTAINER" pg_dump -U "$PGUSER" -d "$PGDATABASE" "$@"

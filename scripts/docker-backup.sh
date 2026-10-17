#!/bin/sh
set -eu
stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
base="/backups/looma-$stamp"
mkdir -p "$base"
# pg_dump takes a consistent transaction snapshot.
# Existing files are immutable. New commits after pg_dump's snapshot are absent from the DB copy.
pg_dump -Fc --no-owner --no-acl > "$base/database.dump.tmp"
mv "$base/database.dump.tmp" "$base/database.dump"
if [ -d /data/storage ]; then cp -a /data/storage "$base/storage"; else mkdir "$base/storage"; fi
printf '{"app":"LOOMA.CRM","format":1,"created_at":"%s","database":"database.dump","storage":"storage"}\n' "$stamp" > "$base/manifest.json"
tar -czf "$base.tar.gz.tmp" -C /backups "looma-$stamp"
mv "$base.tar.gz.tmp" "$base.tar.gz"
rm -rf "$base"
echo "LOOMA backup created: looma-$stamp.tar.gz"
# Automatic deletion is intentionally omitted; retention is managed by the owner.

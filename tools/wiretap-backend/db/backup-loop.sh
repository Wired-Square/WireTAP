#!/bin/sh
# pgBackRest sidecar (compose profile "backup"): on start, creates the stanza
# and switches WAL archiving from the /bin/true placeholder to archive-push;
# then runs scheduled backups — diff daily at 03:00, full on Sundays.
set -u
STANZA=wiretap

echo "backup sidecar: waiting for postgres"
until pg_isready -h /var/run/postgresql -U postgres >/dev/null 2>&1; do
    sleep 2
done

su-exec postgres pgbackrest --stanza="$STANZA" stanza-create || true

psql -h /var/run/postgresql -U postgres -c \
    "ALTER SYSTEM SET archive_command = 'pgbackrest --stanza=${STANZA} archive-push %p'"
psql -h /var/run/postgresql -U postgres -c "SELECT pg_reload_conf()"

su-exec postgres pgbackrest --stanza="$STANZA" check \
    || echo "backup sidecar: WARNING - pgbackrest check failed"

last_day=""
while true; do
    day=$(date +%Y-%m-%d)
    hour=$(date +%H)
    if [ "$hour" = "03" ] && [ "$day" != "$last_day" ]; then
        type=diff
        [ "$(date +%u)" = "7" ] && type=full
        echo "backup sidecar: starting $type backup"
        if su-exec postgres pgbackrest --stanza="$STANZA" --type="$type" backup; then
            last_day="$day"
        else
            echo "backup sidecar: $type backup FAILED"
        fi
    fi
    sleep 300
done

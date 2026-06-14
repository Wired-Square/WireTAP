# TimescaleDB with pgBackRest layered in. pgBackRest is inert unless the
# `backup` compose profile is used (archive_command defaults to /bin/true,
# which recycles WAL without archiving).
FROM timescale/timescaledb:latest-pg16
RUN apk add --no-cache pgbackrest
COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY backup-loop.sh /usr/local/bin/backup-loop.sh
RUN chmod +x /usr/local/bin/backup-loop.sh \
    && mkdir -p /var/lib/pgbackrest \
    && chown postgres:postgres /var/lib/pgbackrest /etc/pgbackrest/pgbackrest.conf

infra/scripts/
  dev-init.sh                # create buckets, meili indexes, prisma migrate
  seed-dev.sh                # call prisma seed, upload sample files to MinIO
  snapshot-db.sh             # pg_dump
  restore-db.sh

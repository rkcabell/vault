#!/bin/sh
# Run pending migrations then hand off to the API process.
set -e

node_modules/.bin/prisma migrate deploy --schema packages/db/prisma/schema.prisma

exec node apps/api/dist/index.js

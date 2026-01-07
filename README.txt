

make up           # docker compose up with health waits
make down         # stop stack
make logs         # tail api/jobs/ocr
make migrate      # prisma migrate deploy
make seed         # prisma seed + sample uploads
make test         # unit tests all packages
make test-int     # api integration with compose
make e2e          # web e2e
make fmt          # format
make lint         # lint
make bench        # k6 smoke
make snapshot     # db + meili snapshot


Env contracts (.env.example at root; service-specific in subfolders)
NODE_ENV=
PORT_API=3000
PORT_WEB=3001
DATABASE_URL=postgresql://user:pass@postgres:5432/vault
REDIS_URL=redis://redis:6379
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_ACCESS_KEY=minio
S3_SECRET_KEY=miniosecret
S3_BUCKET_ORIGINALS=vault-originals
S3_BUCKET_THUMBS=vault-thumbs
MEILI_HOST=http://meilisearch:7700
MEILI_MASTER_KEY=masterkey
JWT_SECRET=change-me
EMAIL_SMTP_HOST=mailhog
EMAIL_SMTP_PORT=1025
EMAIL_FROM=notifications@vault.local
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317

.github/workflows/
  ci.yml                     # pnpm install, lint, typecheck, unit tests
  api-integration.yml        # spin compose (pg/redis/minio/meili), run integration tests
  e2e.yml                    # web e2e (Playwright)
  docker-publish.yml         # build/push images on tags

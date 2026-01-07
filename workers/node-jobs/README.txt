workers/node-jobs/
  src/
    env.ts
    queues/
      mediaPipeline.consumer.ts   # job router; emits next step
      mail.consumer.ts
      housekeeping.consumer.ts
    processors/
      thumbnail.ts                # sharp → WebP
      exif.ts                     # exifr/exiftool
      phash.ts                    # perceptual hash + Hamming distance lookup
      classify.ts                 # rules for id/insurance/warranty/bill
      index.ts                    # Meili/PG FTS update
      suggest-reminders.ts        # due date inference → reminder drafts
      pdf-render.ts               # render PDF page images for OCR/preview
    clients/
      redis.ts
      s3.ts
      meili.ts
      prisma.ts
      api.ts                      # internal API calls if needed
    telemetry/
      metrics.ts
      tracing.ts
    tests/
      unit/
      integration/
  package.json
  tsconfig.json
  .env.example

packages/shared/
  src/
    types/
      media.ts               # Media, Album, Entity, Reminder types
      jobs.ts                # BullMQ payload contracts
    schemas/
      media.zod.ts           # validation mirroring OpenAPI
      search.zod.ts
    clients/
      api.ts                 # lightweight fetch client
  package.json
  tsconfig.json

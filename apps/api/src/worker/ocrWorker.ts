// apps/api/src/worker/ocrWorker.ts
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

// Minimal shape the worker actually uses
type JobPayload = {
  type: "ocr";
  mediaId: string;
  // other fields may exist but aren't required by the stub
  userId?: string;
  storageKey?: string;
  title?: string;
};

// Narrow unknown JSON to JobPayload (no extra runtime behavior)
function isJobPayload(v: unknown): v is JobPayload {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { type?: unknown }).type === "ocr" &&
    typeof (v as { mediaId?: unknown }).mediaId === "string"
  );
}

async function processJob(payload: JobPayload) {
  const { mediaId } = payload;

  // Simulate OCR work (sleep 1s)
  await new Promise((r) => setTimeout(r, 1000));

  // Upsert document text + flip status to READY
  await prisma.document.upsert({
    where: { mediaId },
    update: { rawText: `OCR STUB: File processed at ${new Date().toISOString()}` },
    create: { mediaId, rawText: `OCR STUB: File processed at ${new Date().toISOString()}` },
  });

  await prisma.media.update({
    where: { id: mediaId },
    data: { status: "READY" },
  });

  console.log(`[worker] processed media ${mediaId}`);
}

async function main() {
  console.log("[worker] listening on ocr:queue …");
  while (true) {
    const res = await redis.brpop("ocr:queue", 0); // [key, value] | null
    if (!res) continue;

    const [, data] = res;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (isJobPayload(parsed)) {
        await processJob(parsed);
      } else {
        console.warn("[worker] ignored non-ocr job", parsed);
      }
    } catch (err) {
      console.error("[worker] job failed", err);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

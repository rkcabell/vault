import "dotenv/config";

async function main() {
  console.log("[worker] starting...");
  // TODO: connect to Redis, start BullMQ workers, etc.
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});

import type Redis from "ioredis";

export type QueueClient = {
  push: (queue: string, payload: Record<string, unknown>) => Promise<void>;
};

export function makeQueueClient(redis: Redis): QueueClient {
  return {
    async push(queue: string, payload: Record<string, unknown>) {
      await redis.lpush(queue, JSON.stringify(payload));
    },
  };
}

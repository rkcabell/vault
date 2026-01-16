import pino, { type Logger, type LoggerOptions } from "pino";

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");
const isProd = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";

export function createLogger (name?: string): Logger {
  const options: LoggerOptions = {
    name,
    level,
    base: {},
    messageKey: "message",
    transport:
      isProd || isTest
        ? undefined
        : {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:standard",
              singleLine: true,
            },
          },
    serializers: {
      err: pino.stdSerializers.err,
    },
  };

  return pino(options);
}

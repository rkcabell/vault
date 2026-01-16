type AppLogger = Pick<typeof console, 'info' | 'debug' | 'error' | 'warn'>

export const app: { log: AppLogger } = {
  log: console
}

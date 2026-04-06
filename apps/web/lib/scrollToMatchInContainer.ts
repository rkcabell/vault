import { app } from '@/lib/app'

function debugLog(message: string, data?: Record<string, unknown>) {
  if (process.env.NODE_ENV !== 'development') return
  if (data) {
    app.log.debug(message, data)
    return
  }
  app.log.debug(message)
}

function scrollToCenter(container: HTMLElement, target: HTMLElement) {
  const containerRect = container.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const relativeTop = targetRect.top - containerRect.top + container.scrollTop
  container.scrollTop = relativeTop - container.clientHeight / 2 + targetRect.height / 2
}

export function scrollToMatchInContainer(container: HTMLElement, matchId: string): boolean {
  const primaryTarget = Array.from(
    container.querySelectorAll<HTMLElement>('[data-match-id]'),
  ).find((el) => el.dataset.matchId === matchId)

  if (primaryTarget) {
    scrollToCenter(container, primaryTarget)
    return true
  }

  const fallbackTarget = container.querySelector<HTMLElement>('[data-active-match="true"]')
  if (fallbackTarget) {
    debugLog('scroll:match fallback used', { matchId, reason: 'match-id target missing' })
    scrollToCenter(container, fallbackTarget)
    return true
  }

  debugLog('scroll:match target missing', {
    matchId,
    reason: 'no [data-match-id] and no [data-active-match="true"] element',
  })
  return false
}

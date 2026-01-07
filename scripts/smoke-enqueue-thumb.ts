// scripts/smoke-enqueue-thumb.ts
import {
  makeEnqueueThumbnails,
  THUMB_QUEUE
} from '../apps/api/src/queues/enqueueThumbnail.js'

type Pushed = { queue: string; payload: Record<string, unknown> }

const pushed: Pushed[] = []
const q = {
  async push (queue: string, payload: Record<string, unknown>) {
    pushed.push({ queue, payload })
  }
}

async function main () {
  const enqueueThumb = makeEnqueueThumbnails(q)

  const mediaId = '11111111-1111-1111-1111-111111111111'
  const userId = '22222222-2222-2222-2222-222222222222'
  const storageKey = 'originals/demo.jpg'

  const outKey = await enqueueThumb({ mediaId, userId, storageKey, size: 512 })

  console.log('Returned outKey:', outKey)
  console.log('Pushed count:', pushed.length)
  console.log('First push:', JSON.stringify(pushed[0], null, 2))

  // quick assertions
  if (outKey !== `thumbs/${mediaId}.webp`) throw new Error('outKey mismatch')
  if (pushed[0].queue !== THUMB_QUEUE) throw new Error('queue mismatch')
  const job = pushed[0].payload as any
  if (job.type !== 'thumb') throw new Error('job.type mismatch')
  if (job.mediaId !== mediaId) throw new Error('job.mediaId mismatch')
  if (job.userId !== userId) throw new Error('job.userId mismatch')
  if (job.storageKey !== storageKey) throw new Error('job.storageKey mismatch')
  if (job.outKey !== outKey) throw new Error('job.outKey mismatch')
  if (job.size !== 512) throw new Error('job.size mismatch')

  console.log('smoke-enqueue-thumb passed')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

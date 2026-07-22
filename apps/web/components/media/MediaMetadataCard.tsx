'use client'

import { useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import type { ImageMetadata, MediaDetail, MediaMetadata } from '@/lib/media/types'
import { formatBytes } from '@/lib/media/utils'

type Row = {
  label: string
  value: React.ReactNode
  valueClassName?: string
}

type Section = {
  title: string
  rows: Row[]
}

export function MediaMetadataCard (props: {
  media: MediaDetail
  metadata?: MediaMetadata | null
  localPath?: string | null
  onSaveTitle: (title: string) => Promise<void>
  busy: boolean
  /** When set (and canReveal), the Path row becomes a click-to-reveal button. */
  onRevealPath?: () => void
  canReveal?: boolean
}) {
  const { media, metadata, localPath, onSaveTitle, busy, onRevealPath, canReveal } = props
  const title = media.title || media.filename || 'Media details'

  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [isSavingTitle, setIsSavingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(title)
  const [showGps, setShowGps] = useState(false)

  useEffect(() => {
    setTitleDraft(title)
    setIsEditingTitle(false)
  }, [title])

  useEffect(() => {
    setShowGps(false)
  }, [media.id])

  const startEdit = () => {
    setTitleDraft(title)
    setIsEditingTitle(true)
  }

  const cancelEdit = () => {
    setTitleDraft(title)
    setIsEditingTitle(false)
  }

  const save = async () => {
    const nextTitle = titleDraft.trim()
    if (!nextTitle) return

    setIsSavingTitle(true)
    try {
      await onSaveTitle(nextTitle)
      setIsEditingTitle(false)
    } finally {
      setIsSavingTitle(false)
    }
  }

  const sizeLabel =
    media.sizeBytes !== null && media.sizeBytes !== undefined
      ? `${formatBytes(media.sizeBytes)} (${formatNumber(media.sizeBytes)} bytes)`
      : null

  const sections: Section[] = []

  const generalRows: Row[] = []
  generalRows.push({
    label: 'Title',
    value: isEditingTitle ? (
      <div className='flex w-full flex-col items-end gap-2'>
        <Input
          value={titleDraft}
          onChange={e => setTitleDraft(e.target.value)}
          className='text-right'
          disabled={isSavingTitle || busy}
        />
        <div className='flex items-center gap-2'>
          <Button
            size='sm'
            onClick={save}
            disabled={isSavingTitle || busy}
          >
            {isSavingTitle ? 'Saving...' : 'Save'}
          </Button>
          <Button
            size='sm'
            variant='outline'
            onClick={cancelEdit}
            disabled={isSavingTitle || busy}
          >
            Cancel
          </Button>
        </div>
      </div>
    ) : (
      <div className='flex w-full items-start justify-end gap-2 text-right'>
        <span
          className='min-w-0 flex-1 whitespace-normal break-all font-medium'
          style={{ overflowWrap: 'anywhere' }}
        >
          {title}
        </span>
        <Button
          size='sm'
          variant='outline'
          onClick={startEdit}
          disabled={busy}
          className='shrink-0 h-auto py-0.5 px-2 text-xs'
        >
          Edit
        </Button>
      </div>
    ),
  })

  addRow(generalRows, 'ID', media.id, 'break-all')
  addRow(generalRows, 'Filename', media.filename, 'break-all')
  if (localPath && canReveal && onRevealPath) {
    generalRows.push({
      label: 'Path',
      value: (
        <button
          type='button'
          onClick={onRevealPath}
          disabled={busy}
          title='Reveal in file explorer'
          className='max-w-full cursor-pointer break-all text-right underline-offset-2 hover:underline focus-visible:underline disabled:cursor-default disabled:opacity-50'
          style={{ overflowWrap: 'anywhere' }}
        >
          {localPath}
        </button>
      ),
      valueClassName: 'break-all',
    })
  } else {
    addRow(generalRows, 'Path', localPath, 'break-all')
  }
  addRow(generalRows, 'Size', sizeLabel)
  addRow(generalRows, 'Type', media.mimeType, 'break-all')
  const ext = media.filename?.includes('.') ? media.filename.split('.').pop()?.toUpperCase() : null
  addRow(generalRows, 'Extension', ext ? `.${ext}` : null)
  addRow(generalRows, 'Uploaded', formatDateTime(media.createdAt))
  addRow(generalRows, 'Updated', formatDateTime(media.updatedAt))

  if (generalRows.length) {
    sections.push({ title: 'General', rows: generalRows })
  }

  const image = metadata?.image ?? null
  const imageRows = image ? buildImageRows(image, showGps, () => setShowGps(v => !v)) : []
  if (imageRows.length) {
    sections.push({ title: 'Image', rows: imageRows })
  }

  const pdf = metadata?.pdf ?? null
  const pdfRows: Row[] = []
  if (pdf) {
    addRow(pdfRows, 'Title', pdf.title, 'break-words')
    addRow(pdfRows, 'Author', pdf.author, 'break-words')
    addRow(pdfRows, 'Subject', pdf.subject, 'break-words')
    addRow(pdfRows, 'Creator', pdf.creator, 'break-words')
    addRow(pdfRows, 'Producer', pdf.producer, 'break-words')
    addRow(pdfRows, 'PDF version', pdf.pdfVersion)
    addRow(pdfRows, 'Page count', formatNumber(pdf.pageCount))
    addRow(pdfRows, 'Encrypted', formatBool(pdf.encrypted))
    addRow(pdfRows, 'Created', formatDateTime(pdf.createdAt))
    addRow(pdfRows, 'Modified', formatDateTime(pdf.modifiedAt))
  }
  if (pdfRows.length) {
    sections.push({ title: 'Document', rows: pdfRows })
  }

  const office = metadata?.office ?? null
  const officeRows: Row[] = []
  if (office) {
    addRow(officeRows, 'Application', office.application)
    addRow(officeRows, 'App version', office.appVersion)
    addRow(officeRows, 'Last modified by', office.lastModifiedBy, 'break-words')
    addRow(officeRows, 'Revision', formatNumber(office.revision))
    addRow(officeRows, 'Language', office.language)
    addRow(officeRows, 'Has comments', formatBool(office.hasComments))
    addRow(officeRows, 'Tracked changes', formatBool(office.hasTrackedChanges))
  }
  if (officeRows.length) {
    sections.push({ title: 'Office', rows: officeRows })
  }

  const text = metadata?.text ?? null
  const textRows: Row[] = []
  if (text) {
    addRow(textRows, 'Total characters', formatNumber(text.totalChars))
    addRow(textRows, 'Word count', formatNumber(text.totalWords))
    addRow(textRows, 'Reading time', formatReadingTime(text.totalWords))
    addRow(textRows, 'Page count', formatNumber(text.pageCount))
    addRow(textRows, 'Pages with text', formatNumber(text.pagesWithText))
    addRow(textRows, 'Avg chars/page', formatNumber(text.avgCharsPerPage))
    addRow(textRows, 'Avg words/page', formatNumber(text.avgWordsPerPage))
  }
  if (textRows.length) {
    sections.push({ title: 'Text', rows: textRows })
  }

  return (
    <div className='space-y-6'>
      {sections.map(section => (
        <div key={section.title} className='space-y-3'>
          <div className='text-xs font-semibold uppercase tracking-wide text-muted-foreground'>
            {section.title}
          </div>
          <dl className='space-y-3 text-sm'>
            {section.rows.map(row => (
              <div key={row.label} className='flex items-start gap-3'>
                <dt className='shrink-0 text-muted-foreground'>{row.label}</dt>
                <dd
                  className={`min-w-0 flex-1 text-right ${row.valueClassName ?? ''}`.trim()}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  )
}

function addRow (rows: Row[], label: string, value: React.ReactNode, valueClassName?: string) {
  if (!isPresent(value)) return
  rows.push({ label, value, valueClassName })
}

function isPresent (value: React.ReactNode) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

function buildImageRows (image: ImageMetadata, showGps: boolean, onToggleGps: () => void) {
  const rows: Row[] = []

  const dimensions =
    image.width && image.height ? `${image.width} x ${image.height}` : null
  const aspectRatio =
    image.width && image.height
      ? formatAspectRatio(image.width, image.height)
      : null

  addRow(rows, 'Captured', formatDateTime(image.capturedAt))
  addRow(rows, 'Dimensions', dimensions)
  addRow(rows, 'Aspect ratio', aspectRatio)
  addRow(rows, 'Bit depth', image.bitDepth ? `${image.bitDepth}-bit` : null)
  addRow(rows, 'Alpha channel', formatBool(image.hasAlpha))
  addRow(rows, 'Orientation', formatOrientation(image.orientation))
  addRow(rows, 'Color space', image.colorSpace)
  addRow(rows, 'Camera make', image.make)
  addRow(rows, 'Camera model', image.model)
  addRow(rows, 'Lens', image.lens)
  addRow(rows, 'ISO', formatNumber(image.iso))
  addRow(rows, 'Exposure time', formatExposureTime(image.exposureTime))
  addRow(rows, 'F-number', formatFNumber(image.fNumber))
  addRow(rows, 'Focal length', formatFocalLength(image.focalLengthMm))
  addRow(rows, 'Edited by', image.editedBy)

  if (image.gps) {
    const gpsLabel = showGps ? formatGps(image.gps) : 'Hidden'
    rows.push({
      label: 'GPS',
      value: (
        <div className='flex items-center justify-end gap-2'>
          <span>{gpsLabel}</span>
          <Button
            variant='ghost'
            size='icon'
            type='button'
            onClick={onToggleGps}
            className='h-7 w-7'
            aria-label={showGps ? 'Hide GPS' : 'Show GPS'}
          >
            {showGps ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
          </Button>
        </div>
      ),
      valueClassName: 'flex justify-end',
    })
  }

  return rows
}

function formatNumber (value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return null
  return new Intl.NumberFormat().format(value)
}

function formatDateTime (value?: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

function formatBool (value?: boolean | null) {
  if (value === null || value === undefined) return null
  return value ? 'Yes' : 'No'
}

function formatExposureTime (value?: number | null) {
  if (!value || Number.isNaN(value) || value <= 0) return null
  if (value >= 1) return `${formatNumber(value)} s`
  const fraction = Math.round(1 / value)
  if (fraction > 0) return `1/${fraction} s`
  return `${formatNumber(value)} s`
}

function formatFNumber (value?: number | null) {
  if (!value || Number.isNaN(value)) return null
  const formatted = value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)
  return `f/${formatted}`
}

function formatFocalLength (value?: number | null) {
  if (!value || Number.isNaN(value)) return null
  return `${formatNumber(value)} mm`
}

function formatAspectRatio (width: number, height: number) {
  if (!width || !height) return null
  const divisor = gcd(width, height)
  const simplified = `${Math.round(width / divisor)}:${Math.round(height / divisor)}`
  const decimal = (width / height).toFixed(2)
  return `${simplified} (${decimal})`
}

function gcd (a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y) {
    const temp = y
    y = x % y
    x = temp
  }
  return x || 1
}

function formatOrientation (value?: number | null) {
  if (!value) return null
  const labels: Record<number, string> = {
    1: 'Normal',
    2: 'Flip horizontal',
    3: 'Rotate 180',
    4: 'Flip vertical',
    5: 'Transpose',
    6: 'Rotate 90 CW',
    7: 'Transverse',
    8: 'Rotate 90 CCW',
  }
  return labels[value] ?? `Orientation ${value}`
}

function formatReadingTime (totalWords?: number | null) {
  if (!totalWords || totalWords <= 0) return null
  const minutes = Math.ceil(totalWords / 200)
  return minutes < 1 ? '< 1 min' : `~${minutes} min`
}

function formatGps (gps: { latitude: number; longitude: number; altitude?: number | null }) {
  const lat = gps.latitude.toFixed(5)
  const lon = gps.longitude.toFixed(5)
  const alt =
    gps.altitude === null || gps.altitude === undefined
      ? null
      : `${formatNumber(gps.altitude)} m`
  return alt ? `${lat}, ${lon} | ${alt}` : `${lat}, ${lon}`
}

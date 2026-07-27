/**
 * Wire format of the media event stream (worker → Redis pub/sub → API SSE →
 * browser EventSource). Shared so the API's publisher/whitelist and the web
 * client parse the exact same shape instead of re-declaring it inline.
 */

export const MEDIA_EVENT_FIELDS = [
  /** Per-item worker-state flip; `value` is the new state. */
  "textState",
  "thumbState",
  /** An item's tags changed server-side; `value` is "updated". */
  "tagsUpdated",
  /** Items left the library (bulk delete chunk / single delete); `value` is a
   *  count. `mediaId` is "*" for bulk events. */
  "mediaDeleted",
  /** Items entered the library (index batch / unpack / upload finalize);
   *  `value` is a count. `mediaId` is "*" for bulk events. */
  "mediaCreated",
  /** An in-place item's source file vanished from disk. The row is kept intact
   *  in case this is half of a move, so the item should be shown as missing
   *  rather than removed from the list. `value` is a count; `mediaId` is "*"
   *  for bulk events (a removed directory). */
  "mediaMissing",
  /** A missing item's file was found again at a new path and the existing row
   *  was repointed at it — no id changed, but the filename/title may have.
   *  `value` is a count. */
  "mediaMoved",
] as const;

export type MediaEventField = (typeof MEDIA_EVENT_FIELDS)[number];

export type MediaEvent = {
  mediaId: string;
  field: MediaEventField;
  value: string;
};

export function isMediaEventField(field: string): field is MediaEventField {
  return (MEDIA_EVENT_FIELDS as readonly string[]).includes(field);
}

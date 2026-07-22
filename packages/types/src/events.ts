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

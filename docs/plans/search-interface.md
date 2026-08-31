# Plan: Search & Association Interface

**Status: design only — not implemented.** Written 2026-07 during the `fable-review`
audit branch. The finding: Vault already *extracts* almost everything needed for
association-based retrieval, but the interface exposes only a text box + flat tag
filter. This plan closes that gap without any AI/ML (permanent project rule —
deterministic, rule-based only).

## What the data layer already has

| Signal | Where it lives | Exposed in search UI today? |
|---|---|---|
| Full-text (title + OCR text) | Postgres FTS, GIN `ts_vector` | Yes (`q=` param) |
| Tags | `Media.tags` String[] + GIN, case-insensitive `@>` filter | Yes, flat chips only |
| MIME type / extension | `Media.mimeType`, auto-tag | Partially (type tag) |
| EXIF capture date, camera make/model, GPS presence | `MediaExtractedMetadata.data` | **No** |
| PDF author/title/page count, Office metadata | `MediaExtractedMetadata.data` | **No** |
| Detected text language | computed by OCR pipeline | **No** (detail page only) |
| Source folder structure | `Media.sourcePath` segments | **No** |
| Size, dates, bundle membership | `Media` + `BundleItem` | Sort only / bundle pages |

## Design in three stages

### Stage 1 — Namespaced tags carry the metadata into the existing filter UI

Prerequisite (already merged on this branch): `normalizeTag` accepts one `:`
separator, and `tagNamespace()` exists in `packages/types/src/tags.ts`.

Ship the deterministic auto-tag axes so the existing tag-filter UI becomes an
association browser with no new query machinery:

- `year:2023` / `month:2023-06` — EXIF `capturedAt` → PDF `createdAt` → file mtime.
- `source:upload | source:index | source:unpacked` — known at each ingest site.
- `folder:<segment>` — path segments of `sourcePath` under the indexing root.
- `device:<make-model>`, `lang:<iso>` , `geotagged` — already extracted, one write site each.

Applied by the planned **Tag Organizer** rules engine (see audit: `TagRule` table,
`evaluateRules()` pure function replacing the three inline `buildMimeTypeTag` call
sites, retroactive "Organize now" worker with dry-run). Until that lands, the
axes can be hardcoded rules at the same three ingest sites.

UI change: group the sidebar/filter tag list by namespace (`tagNamespace()`), so
"Year", "Folder", "Type", "Device" appear as collapsible facet groups instead of
one flat cloud. This is a presentation change over data that will already exist.

### Stage 2 — Query language in the search box

Teach the existing search input to parse structured terms before hitting the API
(client-side parse → existing query params; **no schema change**):

```
receipt year:2023 folder:scans type:pdf        → q=receipt & tags=year:2023,folder:scans,type:pdf
camera:iphone -tag:duplicate before:2024-01    → tags/excludeTags/date-range params
```

- `<namespace>:<value>` → tag filter (AND).
- `-<term>` → exclusion (needs one repository addition: NOT `@>` clause).
- `before:/after:` → `createdAt` range (needs two query params + a `where` clause).
- Bare words → FTS `q` as today.
- Autocomplete: on typing `year:`, suggest existing values from `GET /api/tags`
  filtered by prefix — the Tag table already has every value + count.

### Stage 3 — Association surfaces (the explore-page replacement)

Per the audit's explore verdict: delete `components/explorer/*` (dead), keep the
treemap until replaced, then:

1. **Manual document links** (roadmap item) — `MediaLink` join table + a "Related"
   panel on the detail page. Highest-value edge type, cheap.
2. **2D force graph** on `/explore` — nodes = documents (capped/sampled like the
   treemap's `weightBytes` sampling), edges = shared namespaced tags, bundle
   co-membership, manual links. Needs one new endpoint that returns capped edge
   lists; tag co-occurrence must be computed per-namespace (year↔year edges are
   noise; folder/device/manual edges are signal).
3. **3D only if 2D earns it.**

## Sequencing & cost

| Step | Depends on | Size |
|---|---|---|
| Facet-grouped tag sidebar | `:` tags (done) | S |
| year/source/folder auto-tags at ingest | nothing | S |
| Tag Organizer rules engine + retro job | schema (TagRule) | M |
| Search-box query parsing + exclusion/date params | repository additions | M |
| Manual links | schema (MediaLink) | S–M |
| 2D graph explore | links + edge endpoint | L |

Stage 1 alone delivers the owner's stated goal — "find a file via an interface
with associations" — using only data already in Postgres.

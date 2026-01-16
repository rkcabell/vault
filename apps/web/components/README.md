# Components directory

Quick reference for what lives under `apps/web/components` and when to use each piece.

- Root helpers: `providers.tsx` wraps the app with theme + auth + upload providers; `theme-toggle.tsx` is a lightweight theme toggle for pages that don't use the shadcn button variant.
- `common/`: page chrome pieces such as `AppShell` (TopNav + Sidebar layout), `Container` (max-width wrapper), `PageHeader` (title/description/actions row), `SearchInput`, `Sidebar` (tags/saved views nav with loading states), `StatusChip` (worker state pill), `ThemeToggle` (icon button variant), `TopNav` (global nav/search/user menu), and `index.ts` barrel exports.
- `contexts/`: `AuthContext` fetches `/api/auth/me`, holds user/loading state, and exposes logout + `setUser`; `UploadContext` tracks client-side upload queue with helpers for progress/status updates.
- `explorer/`: `ResultCard` renders a search/media tile with thumbnail fallback, status chip, and tags; `ResultGrid` lays results out in a responsive grid; `TagPane` lists available tags for filtering.
- `media/`: `MediaCard` shows a media item thumbnail with fallback and actions (download/rename/delete) in grid/list modes; `MediaCardSkeleton` is its loading placeholder; `MediaInfoCard` surfaces metadata and actions; `MediaPreviewCard` handles visual preview and fallback imagery; `MediaTextPanel` renders extracted/OCR text states; `UploadDialog` handles selecting and enqueuing uploads; `index.ts` is the barrel.
- `ui/`: design-system primitives (`Badge`, `Button`, `Card`, `Input`, `Label`, `Sheet`, `Skeleton`, `Toaster`) plus Radix-based helpers (`DropdownMenu`, `ScrollArea`) and `LogoutButton` which POSTs to `/api/auth/logout` then redirects to `/auth`.

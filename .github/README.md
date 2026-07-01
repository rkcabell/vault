# Vault

Self-hosted Open Source personal document archive & file management solution

<p align="center">
  <!-- [Screenshot] -->
</p>
*IN DEVELOPMENT*

Vault is intended to be run on a home networking setup. 

---

## Features
- **Text Processing** - Vault uses Tesseract OCR to pull text from documents and images
- **Full-text Search** - Search for files by title, filename, or internal text content
- **Tagging** - Files are automatically organized by file extension
- **Bundles** - Group your files how you want
- **In-place Indexing** - Point Vault to a directory to track all files, or blacklist a folder from being reached
- **Thumbnail Preview** - All images, videos, and PDFs display thumbnails
- **Set Reminders** - Attach repeatable reminders to any document
- **ZIP Support** - Compressed folders can be extracted into a bundle, and bundles can be exported as ZIP
- **Vizualize** - View your file makeup with the Explore page treemap
- **UI Themes** - Multiple built-in themes to personalize your Vault application
- **Local-only** - Your files stay on your computer
- **Portable** - Vault can run from a docker container on your network

### Other Features
- Star bundles to pin them
- View metadata for any file
- Customizable profile
- User-created tags take priority over automatic tags
- Real-time processing, watch worker queues

##  Quick Start
Requires [Docker](https://docs.docker.com/get-docker/) and Docker Compose.
Vault will be available at http://localhost:3000

### Windows

### Mac

### Linux

## Project Structure

```
vault/
├── apps/
│   ├── api/          # Fastify REST API + BullMQ workers
│   └── web/          # Next.js frontend
├── packages/
│   ├── db/           # Prisma schema and client
│   └── types/        # Shared TypeScript types
├── infra/
│   └── docker/       # Dockerfiles and Compose configs
├── docs/             # OpenAPI spec, README screenshots
├── test-results/     # Generated HTML test reports
```

## Tech Stack
- **Frontend** — Next.js 16, React 19, Tailwind CSS 4, Radix UI
- **API** — Fastify 4, Zod
- **Database** — PostgreSQL, Prisma
- **Background Jobs** — BullMQ, Redis - OCR, thumbnail generation, and unpacking runs on separate worker processes
- **Auth** — Argon2, JWT
- **File Processing** — Sharp, pdfjs-dist / pdf-lib, heic-convert, ocrmypdf, Tesseract, Ghostscript, qpdf 
- **Object Storage** — S3-compatible (with MinIO) or Filesystem storage

## License
[PolyForm Noncommercial 1.0.0](LICENSE)

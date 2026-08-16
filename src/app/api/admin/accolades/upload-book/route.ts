import { requireAdmin } from "@/lib/admin-auth";
import { ingestPdfUpload } from "@/lib/scraping/pdf";
import { createScrapeJob, markScrapeJobDone, markScrapeJobFailed } from "@/lib/scraping/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/accolades/upload-book
 *   multipart/form-data, field name "file" — a PDF.
 *
 * Runs synchronously within the request rather than truly backgrounded:
 * text extraction + matching a single-user library against one book is a
 * few seconds' work, not the multi-minute crawl a full yearendlists run is.
 * Still writes a scrape_jobs row so it shows up in the same job-history UI.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let file: File;
  try {
    const form = await request.formData();
    const entry = form.get("file");
    if (!(entry instanceof File)) {
      return Response.json(
        { error: "invalid_request", message: "Expected a multipart file field named \"file\"." },
        { status: 400, headers: NO_STORE },
      );
    }
    file = entry;
  } catch {
    return Response.json(
      { error: "invalid_request", message: "Could not read the uploaded form data." },
      { status: 400, headers: NO_STORE },
    );
  }

  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return Response.json(
      { error: "invalid_request", message: "Only PDF uploads are supported." },
      { status: 400, headers: NO_STORE },
    );
  }
  // A generous but real ceiling — this buffers the whole file in memory for
  // pdf-parse, and a single-user local app has no business accepting an
  // unbounded upload.
  const MAX_BYTES = 200 * 1024 * 1024;
  if (file.size > MAX_BYTES) {
    return Response.json(
      { error: "invalid_request", message: "File is larger than the 200MB limit." },
      { status: 400, headers: NO_STORE },
    );
  }

  const job = createScrapeJob("uploaded-books");

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await ingestPdfUpload(file.name, buffer);
    markScrapeJobDone(job.id, result.filmsFound, result.matchedCount);
    return Response.json(
      { ok: true, jobId: job.id, ...result },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    markScrapeJobFailed(job.id, message);
    console.error("[admin/accolades/upload-book] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not process the PDF." },
      { status: 500, headers: NO_STORE },
    );
  }
}

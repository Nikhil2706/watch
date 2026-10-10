import { readdir } from "node:fs/promises";

import { requireAdmin } from "@/lib/admin-auth";
import { env } from "@/lib/env";
import { toLibraryPath } from "@/lib/library-folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv|mpg|mpeg|ts|webm|flv)$/i;

/**
 * GET /api/admin/library/folders?path=
 *
 * The folders inside one folder of the library, read from the disk — so a
 * folder made a minute ago is there to pick, which a listing from Jellyfin
 * would not have until the scan this is for. `path` is the part under the
 * library ("American/Steven Spielberg"); empty is the top. One level per
 * call: the console opens folders as they are clicked.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const asked = new URL(request.url).searchParams.get("path") ?? "";
  const root = env.mediaLibraryPath.replace(/\/+$/, "");
  const dir = asked.trim() ? toLibraryPath(asked, root, env.hostMediaPath) : root;
  if (!dir) {
    return Response.json(
      { error: "invalid_request", message: "That is not a folder in the library." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const folders = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("$"))
        .map(async (e) => {
          const inside = await readdir(`${dir}/${e.name}`, { withFileTypes: true }).catch(() => []);
          return {
            name: e.name,
            // What the scan route takes back: the part under the library.
            path: `${dir}/${e.name}`.slice(root.length + 1),
            folders: inside.filter((x) => x.isDirectory()).length,
            files: inside.filter((x) => x.isFile() && VIDEO.test(x.name)).length,
          };
        }),
    );
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return Response.json(
      { path: dir.slice(root.length + 1), folders, files: entries.filter((e) => e.isFile() && VIDEO.test(e.name)).length },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error("[admin/library/folders] failed:", error);
    return Response.json(
      { error: "not_found", message: "Could not read that folder." },
      { status: 404, headers: NO_STORE },
    );
  }
}

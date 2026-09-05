using VDF.Core;
using VDF.Core.ViewModels;

var builder = WebApplication.CreateBuilder(args);

// Permissive CORS: the step-2 prototype page (curator.html-style, served as a
// browser file:// tab per the integration handoff) sends Origin: null, and this
// API is never reachable from anywhere but this host's own Docker network either
// way — see docker-compose.yml's dupefinder service, which publishes only to
// 127.0.0.1 and carries no tunnel route.
builder.Services.AddCors(o => o.AddPolicy("internal", p => p
    .AllowAnyOrigin()
    .AllowAnyHeader()
    .AllowAnyMethod()));

var app = builder.Build();
app.UseCors("internal");

var apiKey = Environment.GetEnvironmentVariable("DUPEFINDER_API_KEY");
if (string.IsNullOrEmpty(apiKey))
    throw new InvalidOperationException("DUPEFINDER_API_KEY must be set.");

// Shared-secret check, same shape as gate's own ADMIN_API_KEY. Belt-and-braces
// given this service can delete files: the Docker network boundary is the real
// protection, this just means a stray misconfiguration elsewhere isn't also an
// open file-deletion endpoint.
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path == "/healthz" || ctx.Request.Method == HttpMethods.Options)
    {
        await next();
        return;
    }
    if (ctx.Request.Headers["X-Dupefinder-Key"] != apiKey)
    {
        ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await ctx.Response.WriteAsync("unauthorized");
        return;
    }
    await next();
});

var mediaRoot = Path.GetFullPath(Environment.GetEnvironmentVariable("MEDIA_LIBRARY") ?? "/media");
var dataDir = Environment.GetEnvironmentVariable("DATABASE_PATH") ?? "/app/data";
Directory.CreateDirectory(dataDir);

bool IsUnderMediaRoot(string fullPath) =>
    fullPath == mediaRoot || fullPath.StartsWith(mediaRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal);

var scanState = new ScanState();
var engine = new ScanEngine();
engine.Settings.IncludeList.Add(mediaRoot);
engine.Settings.IncludeSubDirectories = true;
// Duplicate images aren't the ask here (see the handoff) — restricting to video
// keeps a first scan of a real library fast enough to be worth prototyping against.
engine.Settings.IncludeImages = false;
engine.Settings.CustomDatabaseFolder = dataDir;
engine.Settings.GeneratePreviewThumbnails = true;
engine.Settings.ThumbnailCount = 3;
engine.Settings.ThumbnailMaxWidth = 240;
engine.Settings.EnablePartialClipDetection = true;

engine.Progress += (_, snapshot) => scanState.Snapshot = snapshot;
engine.FilesEnumerated += (_, _) => scanState.Phase = ScanPhase.Hashing;
engine.BuildingHashesDone += (_, _) => scanState.Phase = ScanPhase.Comparing;
engine.ScanDone += async (_, _) =>
{
    scanState.GroupCount = engine.Duplicates.Select(d => d.GroupId).Distinct().Count();
    scanState.ItemCount = engine.Duplicates.Count;
    // Its own phase, not a silent tail on Comparing: extracting three frames per
    // duplicate across a real library takes minutes, and the caller polling
    // /api/scan/status would otherwise sit on a finished-looking progress bar
    // with no idea anything was still happening.
    var pending = engine.Duplicates.ToList();
    scanState.ThumbnailsTotal = pending.Count;
    scanState.ThumbnailsDone = 0;
    scanState.Phase = ScanPhase.Thumbnails;
    try
    {
        // In batches so the phase can actually report progress. The engine's own
        // ThumbnailProgress event is no use here: it is raised by
        // RetrieveThumbnails(), the fire-and-forget async void variant, and not by
        // the awaitable RetrieveThumbnailsForItems() — and without an await there
        // is nothing to tell us when to move on to Done.
        //
        // Best-effort throughout: a failed extraction leaves that item's ImageList
        // empty and /api/thumbnail 404s for it, rather than failing the scan.
        const int batch = 20;
        for (var i = 0; i < pending.Count; i += batch)
        {
            await engine.RetrieveThumbnailsForItems(pending.Skip(i).Take(batch));
            scanState.ThumbnailsDone = Math.Min(i + batch, pending.Count);
        }
    }
    catch { }
    scanState.Phase = ScanPhase.Done;
};
engine.ScanAborted += (_, _) => scanState.Phase = ScanPhase.Aborted;

await ScanEngine.LoadDatabase(dataDir);

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

app.MapPost("/api/scan/start", () =>
{
    lock (scanState.Lock)
    {
        if (scanState.Phase is ScanPhase.Hashing or ScanPhase.Comparing or ScanPhase.Thumbnails)
            return Results.Conflict(new { error = "scan already running" });
        scanState.Phase = ScanPhase.Hashing;
        scanState.GroupCount = 0;
        scanState.ItemCount = 0;
        scanState.ThumbnailsDone = 0;
        scanState.ThumbnailsTotal = 0;
    }
    engine.StartSearch();
    return Results.Accepted(value: new { status = "started" });
});

app.MapPost("/api/scan/stop", () =>
{
    engine.Stop();
    return Results.Ok(new { status = "stopping" });
});

app.MapGet("/api/scan/status", () => Results.Ok(new
{
    phase = scanState.Phase.ToString().ToLowerInvariant(),
    currentFile = scanState.Snapshot?.CurrentFile,
    currentStage = scanState.Snapshot?.CurrentStage,
    currentPosition = scanState.Snapshot?.CurrentPosition ?? 0,
    maxPosition = scanState.Snapshot?.MaxPosition ?? 0,
    elapsedSeconds = scanState.Snapshot?.Elapsed.TotalSeconds ?? 0,
    remainingSeconds = scanState.Snapshot?.Remaining.TotalSeconds ?? 0,
    groupCount = scanState.GroupCount,
    itemCount = scanState.ItemCount,
    thumbnailsDone = scanState.ThumbnailsDone,
    thumbnailsTotal = scanState.ThumbnailsTotal,
}));

// Groups/thumbnail/delete all read (or mutate) engine.Duplicates directly, which
// the scan pipeline itself is still writing to during Hashing/Comparing — a 409
// here is cheaper than chasing a HashSet-modified-during-enumeration exception.
app.MapGet("/api/groups", () =>
{
    if (scanState.Phase != ScanPhase.Done)
        return Results.Conflict(new { error = "no completed scan yet" });

    var groups = engine.Duplicates
        .GroupBy(d => d.GroupId)
        .Select(g => new
        {
            groupId = g.Key,
            // Longest first: in a group that pairs a film with a clip of itself,
            // the full-length copy is the one to look at first.
            items = g.Select(ToItemDto).OrderByDescending(i => i.DurationSeconds).ToArray(),
        })
        .ToArray();
    return Results.Ok(groups);
});

app.MapGet("/api/thumbnail", (string path, int frame) =>
{
    if (scanState.Phase != ScanPhase.Done)
        return Results.Conflict(new { error = "no completed scan yet" });

    var full = Path.GetFullPath(path);
    // Not Results.Forbid(): that one goes through the authentication stack, and
    // this service registers no authentication scheme (the key check is plain
    // middleware), so it would throw rather than return a 403.
    if (!IsUnderMediaRoot(full))
        return Results.StatusCode(StatusCodes.Status403Forbidden);

    var item = engine.Duplicates.FirstOrDefault(d => d.Path == full);
    if (item == null || frame < 0 || frame >= item.ImageList.Count)
        return Results.NotFound();
    return Results.Bytes(item.ImageList[frame], "image/jpeg");
});

app.MapPost("/api/delete", (DeleteRequest req) =>
{
    if (scanState.Phase != ScanPhase.Done)
        return Results.Conflict(new { error = "no completed scan yet" });

    var results = new List<object>();
    foreach (var p in req.Paths)
    {
        var full = Path.GetFullPath(p);
        if (!IsUnderMediaRoot(full))
        {
            results.Add(new { path = p, deleted = false, error = "outside media root" });
            continue;
        }
        // Only ever delete a path this same scan actually flagged as a duplicate —
        // never an arbitrary path under /media the caller happens to send.
        var item = engine.Duplicates.FirstOrDefault(d => d.Path == full);
        if (item == null)
        {
            results.Add(new { path = p, deleted = false, error = "not in current scan results" });
            continue;
        }
        try
        {
            if (ScanEngine.GetFromDatabase(full, out var dbEntry) && dbEntry != null)
                ScanEngine.RemoveFromDatabase(dbEntry);
            if (File.Exists(full))
                File.Delete(full);
            engine.Duplicates.Remove(item);
            results.Add(new { path = p, deleted = true });
        }
        catch (Exception ex)
        {
            results.Add(new { path = p, deleted = false, error = ex.Message });
        }
    }
    ScanEngine.SaveDatabase();
    return Results.Ok(results);
});

app.Run();

// A named record rather than an anonymous type: ToItemDto is used from within a
// LINQ chain (.OrderByDescending(i => i.IsBestSize)) at its call site, and an
// anonymous type's members aren't visible once the method's declared return type
// is `object`.
static ItemDto ToItemDto(DuplicateItem d) => new(
    Path: d.Path,
    Folder: d.Folder,
    Size: d.SizeLong,
    SizeDisplay: d.Size,
    // DELIBERATELY RENAMED. VDF's DuplicateItem.IsBestSize is
    // `items.Min(d => d.SizeLong)` — "best" there means SMALLEST FILE, i.e. most
    // disk saved, while every other IsBestX on that type is a Max (longest,
    // highest bitrate, biggest frame). Passing "isBestSize" through to a UI whose
    // next action is DELETE invites exactly one mistake: keep the most truncated
    // copy, delete the original. It is called what it is here.
    IsSmallestSize: d.IsBestSize,
    DurationSeconds: d.Duration.TotalSeconds,
    IsLongestDuration: d.IsBestDuration,
    FrameSize: d.FrameSize,
    Fps: d.Fps,
    Format: d.Format,
    AudioFormat: d.AudioFormat,
    HdrFormat: d.HdrFormat,
    Similarity: d.Similarity,
    IsImage: d.IsImage,
    IsAiMatched: d.IsAiMatched,
    IsPartialClip: d.Flags.HasFlag(DuplicateFlags.PartialClip),
    PartialClipOffsetSeconds: d.PartialClipOffset.TotalSeconds,
    ThumbnailCount: d.ImageList.Count);

record ItemDto(
    string Path, string Folder, long Size, string SizeDisplay, bool IsSmallestSize,
    double DurationSeconds, bool IsLongestDuration, string? FrameSize, float Fps,
    string? Format, string? AudioFormat, string HdrFormat, float Similarity,
    bool IsImage, bool IsAiMatched, bool IsPartialClip, double PartialClipOffsetSeconds,
    int ThumbnailCount);

record DeleteRequest(string[] Paths);

class ScanState
{
    public readonly object Lock = new();
    public volatile ScanPhase Phase = ScanPhase.Idle;
    public ScanProgressSnapshot? Snapshot;
    public int GroupCount;
    public int ItemCount;
    public int ThumbnailsDone;
    public int ThumbnailsTotal;
}

enum ScanPhase { Idle, Hashing, Comparing, Thumbnails, Done, Aborted }

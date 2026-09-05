# dupefinder

Internal sidecar service for duplicate-video detection, wrapping
[VDF.Core](https://github.com/0x90d/videoduplicatefinder) (vendored at
`VDF.Core/`, see `VENDORED.md`) behind a small HTTP API of our own
(`DupeFinder.Api/`). Full context: `../vdf_jellyfin_gate_handoff.md`.

This is **not** started by a plain `docker compose up -d` — it's behind the
`dupefinder` profile, the same pattern `party-retired` uses in the main
`docker-compose.yml`, so the boot script and routine restarts can't build or
start it by accident:

```bash
cd /mnt/c/Users/Dell/Downloads/jellyfin-gate
docker compose --env-file .env --env-file .env.wsl-paths --profile dupefinder up -d --build dupefinder
```

Requires `DUPEFINDER_API_KEY` set in `.env` (any random string — same shape
as `ADMIN_API_KEY`).

## API

All routes except `/healthz` require an `X-Dupefinder-Key: <DUPEFINDER_API_KEY>`
header.

| Route | Method | Notes |
|---|---|---|
| `/healthz` | GET | No auth. |
| `/api/scan/start` | POST | 409 if a scan is already running. |
| `/api/scan/stop` | POST | Cancels the in-progress scan. |
| `/api/scan/status` | GET | Phase + live progress snapshot. |
| `/api/groups` | GET | 409 until a scan has completed. Array of `{ groupId, items[] }`. |
| `/api/thumbnail?path=&frame=` | GET | One JPEG frame (`frame` is 0-based, up to `thumbnailCount` in the item DTO). |
| `/api/delete` | POST | Body `{ "paths": [...] }`. Only deletes paths present in the last completed scan's results, under the configured media root. |

### `isSmallestSize` is not "the best copy"

The DTO renames VDF's own `DuplicateItem.IsBestSize`, and the rename is load
bearing. In VDF that flag is `items.Min(d => d.SizeLong)` — "best" there means
*smallest file*, i.e. most disk reclaimed — while every other `IsBestX` on that
type is a `Max`. A UI whose next action is **delete** must not read it as "the
one to keep": during testing it flagged an 8-second clip as best over the
30-second source it was cut from. The keeper is chosen in the console instead
(`dfPickKeeper`): never a partial clip, then longest, then highest resolution,
then bitrate, then file size.

## Verifying without deploying

No local .NET SDK on this machine — build/typecheck via a throwaway
container, same idea as the main repo's `docker run node:...` pattern:

```bash
docker run --rm -v "$(pwd):/src" -w /src mcr.microsoft.com/dotnet/sdk:10.0 \
  dotnet build DupeFinder.Api/DupeFinder.Api.csproj -c Release
```

This is also exactly what the Dockerfile's build stage does, so a clean
build here means the image build will succeed too.

## The UI

The **Duplicates** tab in `../curator.html`. It talks to this service
directly rather than through the gate, so changing it stays a console-only
edit with no image rebuild — see that tab's own comment for the reasoning.

There was briefly a standalone `console.html` here (the handoff's step-2
prototype). It is gone: once the tab existed, the two were the same code
twice, and the first bug found after that had to be fixed in both.

## What's not done yet

Review-decision persistence (kept/deleted/ignored across restarts) is
deliberately out of scope for this first cut — a completed scan's results
live only in this process's memory until the next `/api/scan/start`. Also
not done: the app-parity backlog entries (step 5 of the handoff), which are
due now that the UI shape is settled.

# Upload scanner — setup (registered, not yet tested)

`upload-scanner.ps1` runs the Windows Defender side of the Langlois-mode
upload pipeline: quarantine → **this script** → curator approval. The
`JellyfinGateUploadScanner` Scheduled Task was registered 2026-08-20 (every
5 minutes, `-RunLevel Highest`) — it is running now. What's still
outstanding is step 3 below: a real EICAR-file test to confirm the
`Get-MpThreatDetection` matching logic actually catches a detection on this
machine's Defender version, not just by inspection. Steps:

1. **Confirm the quarantine path matches reality.** The script reads
   `$env:JELLYFIN_GATE_QUARANTINE_PATH`, falling back to
   `C:\Users\Dell\Downloads\jellyfin-gate\media-quarantine` if that's unset.
   That fallback matches `docker-compose.yml`'s own default
   (`${MEDIA_QUARANTINE_PATH:-./media-quarantine}`) — if `.env` overrides
   `MEDIA_QUARANTINE_PATH` to somewhere else, either set the same env var
   for the scheduled task's context or edit the script's fallback to match.

2. **Register the Scheduled Task**, same shape as `JellyfinGateWatchdog`:
   ```powershell
   $action = New-ScheduledTaskAction -Execute "powershell.exe" `
     -Argument "-NoProfile -ExecutionPolicy Bypass -File `"C:\Users\Dell\Downloads\jellyfin-gate\scripts\windows\upload-scanner.ps1`""
   $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
   Register-ScheduledTask -TaskName "JellyfinGateUploadScanner" -Action $action -Trigger $trigger -RunLevel Highest
   ```
   `[TimeSpan]::MaxValue` looks like the obvious way to say "repeat forever,"
   but Task Scheduler's XML duration field can't represent it —
   `Register-ScheduledTask` fails with "The task XML contains a value which
   is incorrectly formatted or out of range" (`P99999999DT23H59M59S`
   overflows the schema). A long-but-finite duration like 10 years works
   and needs no maintenance on any human timescale. Confirmed registering
   successfully 2026-08-20.
   Runs as the current user by default, not SYSTEM — unlike the Docker
   watchdog, this doesn't need SYSTEM's PATH, so this is simpler on
   purpose. If it's changed to run as SYSTEM later, re-check the same PATH
   gotcha documented in `docker-watchdog.ps1`'s own comments (SYSTEM's PATH
   doesn't include user-installed tools) — `MpCmdRun.exe` is resolved by
   this script via absolute paths already, so that specific gotcha
   shouldn't bite here, but worth keeping in mind.

3. **Test it for real before trusting it**, with the standard
   [EICAR test file](https://www.eicar.org/download-anti-malware-testfile/)
   — a harmless string every antivirus product recognises as a test
   signature, not a real threat. Upload it through the Langlois-mode upload
   UI, run the scanner manually once (`powershell -File
   .\upload-scanner.ps1`), and confirm the matching upload shows
   `status: infected` with a threat name in the curator's Uploads tab. This
   hasn't been done yet — the `Get-MpThreatDetection` matching logic in the
   script is reasoned through, not verified against a real detection event
   on this machine's specific Defender version.

4. **Confirm the "clean" path too** — upload something real and small, run
   the scanner, confirm it shows `status: clean` and the Approve button in
   the curator's Uploads tab becomes available.

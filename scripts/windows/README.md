# Upload scanner — setup (NOT set up on the current PC; never tested)

`upload-scanner.ps1` runs the Windows Defender side of the Langlois-mode
upload pipeline: quarantine → **this script** → curator approval.

**State, 2026-10-04.** The `JellyfinGateUploadScanner` Scheduled Task was
registered on the previous machine (the Dell) on 2026-08-20. It was not
carried over when the site moved to the HP: that PC has only
`JellyfinGateTunnel` and `JellyfinGateWslBoot`. Nothing has been uploaded
since, so nothing is stuck, but an upload made today would wait for a scan
for good. The console's Health tab now has an "Upload scanner" card that
says so. Two bugs that would have stopped it working even where it was
registered are fixed in the script (see its header): scan results were
written with a byte-order mark the site could not parse, and a scan that
failed to run was reported as clean.

Steps:

1. **Point it at the quarantine folder.** The script reads
   `$env:JELLYFIN_GATE_QUARANTINE_PATH` and refuses to run without it. It
   must be the Windows path behind the gate container's `/quarantine` mount
   (`MEDIA_QUARANTINE_PATH` in `.env`, default `./media-quarantine`).

   On the HP the stack runs inside WSL, so that default is
   `/home/jellyfin/watch/media-quarantine`, which Windows sees as
   `\\wsl.localhost\Ubuntu\home\jellyfin\watch\media-quarantine`. Whether
   Defender will scan a file at a `\\wsl.localhost` path is **untested**. The
   safer arrangement is the one `MEDIA_INCOMING` already uses there: put the
   folder on a Windows drive (for example `MEDIA_QUARANTINE_PATH=/mnt/c/Media/quarantine`
   in the WSL-paths env file, then recreate the gate and worker containers)
   and give the script `C:\Media\quarantine`. Defender's real-time protection
   then sees each upload as it is written, as well as this scan.

   Set it for the account the task runs as:
   ```powershell
   [Environment]::SetEnvironmentVariable("JELLYFIN_GATE_QUARANTINE_PATH", "C:\Media\quarantine", "User")
   ```

2. **Register the Scheduled Task.** Copy `upload-scanner.ps1` to a folder
   on the Windows side first (its log is written beside it), then:
   ```powershell
   $action = New-ScheduledTaskAction -Execute "powershell.exe" `
     -Argument "-NoProfile -ExecutionPolicy Bypass -File `"C:\Users\HP\jellyfin-gate\upload-scanner.ps1`""
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

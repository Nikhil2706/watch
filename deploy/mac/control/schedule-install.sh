#!/bin/bash
# Run as root (the app asks for the password): installs or refreshes the
# schedule daemon, then books events now. The script is copied to a
# root-owned folder so a root job never runs a file the user account can edit.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
install -d -o root -g wheel -m 755 "/Library/Application Support/watch"
install -o root -g wheel -m 755 "$SRC/schedule-apply.py" "/Library/Application Support/watch/schedule-apply.py"
install -o root -g wheel -m 644 "$SRC/com.watch.schedule.plist" /Library/LaunchDaemons/com.watch.schedule.plist
launchctl bootout system/com.watch.schedule 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/com.watch.schedule.plist
sleep 2
pmset -g sched

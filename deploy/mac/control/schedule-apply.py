#!/usr/bin/python3
"""Books the Mac's next shutdowns and start-ups from the owner's weekday and
weekend hours. Run as root, hourly and at boot, by the launch daemon
com.watch.schedule (installed by the Watch Control app).

macOS's own repeating schedule (pmset repeat) allows one off time and one on
time for all days, so instead this books one-off events (pmset schedule) for
the next three days and re-books them every hour. Each event takes the rule
of the calendar day it falls on: Mon-Fri use the weekday times, Sat-Sun the
weekend times (so a 01:00 shutdown in the night from Friday to Saturday uses
the weekend time).

Settings: ~nikhilmamnani/.config/watch/schedule.json, written by the app:
  {"enabled": true, "weekday": {"off": "01:00", "on": "09:00"},
                    "weekend": {"off": "02:00", "on": "10:00"}}
"""
import datetime, json, subprocess, sys

CONF = "/Users/nikhilmamnani/.config/watch/schedule.json"
LOG = "/Library/Logs/watch-schedule.log"

def log(msg):
    with open(LOG, "a") as f:
        f.write(f"[{datetime.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}\n")

def pmset(*args):
    return subprocess.run(["/usr/bin/pmset", *args], capture_output=True, text=True)

try:
    conf = json.load(open(CONF))
except Exception as e:
    conf = {"enabled": False}

pmset("repeat", "cancel")
pmset("schedule", "cancelall")
if not conf.get("enabled"):
    log("schedule off - nothing booked")
    sys.exit(0)

now = datetime.datetime.now()
booked = []
for d in range(0, 4):
    day = (now + datetime.timedelta(days=d)).date()
    rule = conf["weekend"] if day.weekday() >= 5 else conf["weekday"]
    for kind, key in (("shutdown", "off"), ("wakeorpoweron", "on")):
        h, m = map(int, rule[key].split(":"))
        at = datetime.datetime.combine(day, datetime.time(h, m))
        if at <= now + datetime.timedelta(minutes=1):
            continue
        r = pmset("schedule", kind, at.strftime("%m/%d/%y %H:%M:%S"))
        booked.append(f"{kind} {at:%a %d %b %H:%M}" + ("" if r.returncode == 0 else f" FAILED {r.stderr.strip()}"))
log("booked: " + "; ".join(booked))

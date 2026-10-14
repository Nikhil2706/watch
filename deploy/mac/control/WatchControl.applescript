-- Watch Control: the owner's buttons for the Watch site on this Mac.
-- Source of ~/Desktop/Watch Control.app (osacompile -o ... this file).
property ctl : "bash ~/watch-ops/control/control.sh "

on run
	repeat
		set statusText to do shell script ctl & "status"
		set choice to choose from list {"Disconnect film drive (takes the site down)", "Start the site", "Deploy latest merged code", "Roll back the last deploy", "Set off-hours schedule", "Turn off-hours schedule off", "Refresh"} with title "Watch Control" with prompt statusText & return & return & "What would you like to do?" OK button name "Do it" cancel button name "Close"
		if choice is false then return
		set c to item 1 of choice
		if c starts with "Disconnect" then
			doDisconnect()
		else if c starts with "Start" then
			set r to do shell script ctl & "start; true"
			if r contains "NO_DRIVE" then
				display alert "The film drive isn't connected." message "Plug it in. The site then starts by itself within about two minutes."
			else if r contains "UP" then
				display notification "The site is up." with title "Watch"
			else
				display alert "The site didn't come back within two minutes." message "Look at ~/Library/Logs/watch-control.log, or ask Claude."
			end if
		else if c starts with "Deploy" then
			display dialog "This takes the latest code merged on GitHub (platform-additions) live." & return & return & "It checks and builds first while the site keeps running, waits if anyone is watching, then restarts the site (about 30 seconds). If the new version doesn't start, it puts the old one back by itself." & return & return & "You'll get notifications as it goes." buttons {"Cancel", "Deploy"} default button "Deploy" with title "Deploy"
			do shell script "nohup bash ~/watch-ops/control/control.sh deploy >/dev/null 2>&1 &"
			return
		else if c starts with "Roll back" then
			display dialog "Put back the version that was running before the last deploy? The site is down for about 30 seconds." buttons {"Cancel", "Roll back"} default button "Roll back" with title "Roll back"
			set r to do shell script ctl & "rollback; true"
			if r contains "UP" then
				display notification "The previous version is back." with title "Watch"
			else
				display alert "Rollback didn't work: " & r message "Ask Claude, or see ~/Library/Logs/watch-control.log."
			end if
		else if c starts with "Set off-hours" then
			doSchedule()
		else if c starts with "Turn off-hours" then
			do shell script "mkdir -p ~/.config/watch && printf '%s' '{\"enabled\": false}' > ~/.config/watch/schedule.json"
			do shell script "bash ~/watch-ops/control/schedule-install.sh" with administrator privileges
			display notification "The Mac stays on all the time now." with title "Watch"
		end if
	end repeat
end run

on doDisconnect()
	set r to do shell script ctl & "disconnect; true"
	if r starts with "BUSY" then
		set n to word 2 of r
		display dialog n & " stream(s) are playing right now. Disconnecting stops them." buttons {"Cancel", "Stop them and disconnect"} default button "Cancel" with title "Someone is watching"
		set r to do shell script ctl & "disconnect force; true"
	end if
	if r contains "NOT_EJECTED" then
		display alert "The site is off, but macOS wouldn't eject the drive." message "Something still has it open. In Finder, eject Elements and choose Force Eject; nothing of the site is writing to it now. When you plug it back in, the site starts by itself."
	else
		display alert "Safe to unplug the drive." message "The site is off. When you plug the drive back in, it starts again by itself within about two minutes (or use Start the site)."
	end if
end doDisconnect

on doSchedule()
	set wOff to my askTime("WEEKDAYS (Mon-Fri): shut the Mac down at", "01:00")
	set wOn to my askTime("WEEKDAYS (Mon-Fri): start it again at", "09:00")
	set eOff to my askTime("WEEKENDS (Sat-Sun): shut the Mac down at", "02:00")
	set eOn to my askTime("WEEKENDS (Sat-Sun): start it again at", "10:00")
	if wOff is false or wOn is false or eOff is false or eOn is false then return
	set json to "{\"enabled\": true, \"weekday\": {\"off\": \"" & wOff & "\", \"on\": \"" & wOn & "\"}, \"weekend\": {\"off\": \"" & eOff & "\", \"on\": \"" & eOn & "\"}}"
	do shell script "mkdir -p ~/.config/watch && printf '%s' " & quoted form of json & " > ~/.config/watch/schedule.json"
	do shell script "bash ~/watch-ops/control/schedule-install.sh" with administrator privileges
	display alert "Schedule on." message "Weekdays: off " & wOff & ", on " & wOn & return & "Weekends: off " & eOff & ", on " & eOn & return & return & "Each time counts by the day it falls on, so a 01:00 shutdown in the night from Friday to Saturday uses the weekend time. Save your work before the off time: an app with unsaved changes (Final Cut, for one) can stop the shutdown. If you switch the Mac on during the off hours it just runs, and the site comes up, until the next off time."
end doSchedule

on askTime(promptText, defaultTime)
	repeat
		set t to text returned of (display dialog promptText & " (24-hour, HH:MM):" default answer defaultTime with title "Off-hours schedule")
		if my okTime(t) then return t
		display alert "Times must look like 02:00 or 23:30."
	end repeat
end askTime

on okTime(t)
	try
		if (count of t) is not 5 or character 3 of t is not ":" then return false
		set h to (text 1 thru 2 of t) as integer
		set m to (text 4 thru 5 of t) as integer
		return h ≥ 0 and h ≤ 23 and m ≥ 0 and m ≤ 59
	on error
		return false
	end try
end okTime

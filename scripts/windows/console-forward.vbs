' Keeps the curator console reachable on the home Wi-Fi (see console-forward.js).
' Run by the JellyfinGateConsoleForward scheduled task. Window style 0 = hidden;
' True = wait, so the task stays Running and its restart-on-failure applies.
CreateObject("WScript.Shell").Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\HP\jellyfin-gate\console-forward.js""", 0, True

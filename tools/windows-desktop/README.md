# Windows desktop build (the PC)

The PC runs the desktop app built from this fork, not upstream's release. Every Claude session runs inside that app's server, so replacing it is done by a detached script that waits until no agent is working.

## Build

```sh
# on the PC, from a checkout of this fork
fleet push laptop-gerrit tools/windows-desktop --as t3-desktop-build
fleet push laptop-gerrit "$LOCALAPPDATA/Programs/t3code/resources/resource-monitor" --as t3-desktop-rm
fleet job start laptop-gerrit --name t3desk --in t3-desktop-build -- bash build.sh main /c/fleet/work/t3-desktop-rm/t3-resource-monitor.exe
fleet job wait t3desk --timeout 30m          # about 8 minutes; prints INSTALLER <path>
fleet pull laptop-gerrit t3d release/T3-Code-<version>-x64.exe --to ~/.t3/fork-switch/
```

- Windows nodes only. The work tree `C:\fleet\work\t3d` is kept between builds.
- The nodes have no Rust toolchain, so the build reuses `t3-resource-monitor.exe` from the installed app.
- The build bakes in T3 Connect's public config (relay, Clerk keys) the way upstream's releases do, so `t3 connect` and the relay work.
- The build has no update feed (`app-update.yml` is missing), so the app never updates itself to upstream. Updating means building and switching again.

## Switch

`switch.ps1` waits until no run is active and nobody is recording a voice message for two minutes. Then it stops the app, backs up the install and `statev2.sqlite` to `~/.t3/fork-switch/backup-<time>`, installs silently over the same per-user install, sets the `T3 Code` autostart entry (HKCU Run), starts the app and waits for the new server. If anything fails, it restores the old install and database. With `-NotifyThread <threadId>` it posts the result into that thread through `t3 thread send`, which wakes the agent there on the new server.

Start it outside the app's process tree, then end your turn so the app gets quiet:

```powershell
Copy-Item tools\windows-desktop\switch.ps1 $HOME\.t3\fork-switch\
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$HOME\.t3\fork-switch\switch.ps1`" -Installer `"$HOME\.t3\fork-switch\release\T3-Code-0.1.7-x64.exe`" -NotifyThread <threadId>"
Register-ScheduledTask -TaskName T3ForkSwitch -Force -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument $arguments) | Out-Null
Start-ScheduledTask -TaskName T3ForkSwitch
```

Log: `~/.t3/fork-switch/switch.log`. A successful switch writes `~/.t3/fork-switch/done`. Delete old `backup-*` folders once the new version has run for a day.

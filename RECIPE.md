# Port Forward

Auto port forwarding for ssh machines, like VS Code and Cursor. Start a server (or run `aws sso login`) on a remote machine and its port appears on `localhost` within seconds. A thin bar at the bottom of the window shows what is forwarded; clicking it opens a Ports panel with a table of every forward, and right-clicking a row gives a menu.

![Port Forward](preview.png)

## What you see

**The bar** is a block in the layout (shipped `mod.json`: `place: bottom`, `size: 26`; in `main` it sits right of `workspace-status`, about 260px wide). `chrome` background, 1px `border` top line, 11.8px `muted` text, `foreground` on hover, pointer cursor. Text is `⇄ Ports` or `⇄ Ports · 8801, 9300` (the *local* ports, truncated).

**The Ports panel** is a dialog (720x380, `popover` background, 18px padding) with a "Ports" title (15px semibold) and `Esc` hint top right, then a table:

| Port | Forwarded Address | Running Process | Origin | (✕) |
|---|---|---|---|---|

Columns are 96px, 170px, flexible, 130px and 30px. Header row is 30px, 11.5px `dim` text, 1px `border` underneath. Rows are 34px, 12.5px text, `raised` background on hover. Port is the remote port (plus the machine name in 10.5px `dim` when more than one machine is connected). Address is `localhost:<local port>` in `accent`, or the error in `blocked` color when the forward failed. Process is `name (pid)` in `muted`. Origin is `Auto Forwarded` or `User Forwarded` in `muted`. Empty state: "No forwarded ports yet. Start a server on a remote machine, or add one." (or "Connect an ssh machine to forward its ports."). The last element is a 30px bordered `+ Add Port` button.

**The row menu** is a 210x118 popup (`popover`, 4px padding) with three 30px items: Open in Browser, Change Local Port…, Stop Forwarding.

## How it behaves

- **Detection.** Every 3 seconds, for each machine from `hc machine ls --json` that is `connected`, not `via`, not `temporary`, run `ss -H -ltnp` on it (fallback: `/proc/net/tcp{,6}` printed in `ss`'s shape). Keep listeners bound to `127.0.0.1`, `0.0.0.0`, `*`, `[::1]`, `[::]` or `::`. Process comes from `users:(("name",pid=N`; it is blank for other users' processes. Auto-forward only ports 1024-65535 (a top-level `IGNORE` set excludes more).
- **Forwarding.** One ssh ControlMaster per machine: `ssh -fN -o ControlMaster=yes -o ControlPersist=yes -o ControlPath=/tmp/herdr-pf/<first 12 chars of machine id>.sock -o BatchMode=yes -o ServerAliveInterval=15 -o ExitOnForwardFailure=no <target>` (`target` from `hc machine ls`). Each forward is `ssh -S <sock> -O forward -L 127.0.0.1:<local>:127.0.0.1:<remote> <target>`; cancelling uses `-O cancel` with the same spec. On first sync per machine, any master left by an earlier run is stopped with `-O exit` so forwards start clean; on close the bar copy stops every master.
- **Auto forwards** use the same local port as the remote one and raise an info toast ("Forwarded port 8801", body `<machine> → localhost:8801`). When the remote stops listening, the forward is cancelled and the row disappears. A forward that fails (local port in use, ssh refuses) is kept as an error row, with one warning toast, and is retried only when its local port changes.
- **Add Port** reveals a text input (and one chip per machine when several are connected), a Forward button and Cancel. Enter submits. The port must be an integer 1-65535. A user forward is made even if nothing listens remotely yet, is never auto-cancelled, and is saved (shared `pf.user`).
- **Row menu** (right-click, opened at the click's `position`):
  - Open in Browser runs `open http://localhost:<local>` (disabled on error rows). Clicking the address does the same.
  - Change Local Port… shows "Local port for <remote>:" with an input at the panel's bottom; saving remaps to `127.0.0.1:<new>:127.0.0.1:<remote>`, cancelling the old forward. The mapping is saved (shared `pf.map`) and reapplied after restarts.
  - Stop Forwarding (and the row's ✕) cancels the forward and removes it from `pf.user` and `pf.map`. An auto port closed this way stays closed until the remote stops listening and starts again.
- **Esc** leaves the Add/Change input first, then closes the dialog.

## Built from

One mod, `mods/port-forward/` (`main.js`, `mod.json`), no keys, no layout. One class, three modes picked from `props()`: bar (none), panel (`{panel: true}`, opened with `openOverlay({mod, kind: "dialog", width: 720, height: 380, props})`), menu (`{menu: {machine, port, local, error}}`, opened with `kind: "popup", width: 210, height: 118, at: {x, y}` from the right-click event's `position`).

The **bar copy owns all ssh work**. The panel and menu never run ssh; they talk to it through shared state:

- `pf.state` `{rows: [{machine, port, local, proc, origin: "auto"|"user", error}], machines: [names]}`, published by the bar (only when changed) and read by the panel and bar text.
- `pf.req` an array of `{id, op: "add"|"close"|"remap", machine, port, local?}`, appended by the panel/menu (keep the last 20). The bar polls it every 500ms and runs unseen ids; ids already present when the bar starts are marked seen so a restart does not replay them.
- `pf.user` `[{machine, port}]` user-forwarded ports; `pf.map` `[{machine, port, local}]` local-port overrides; `pf.ui` `{id, remap: {machine, port, local}}` how the menu asks the panel to show the Change Local Port input (the panel polls it every 150ms).

Uses `exec`, `hc`, `theme`, `notify`, `shared`, `setShared`, `props`, `openOverlay`, `closeOverlay` from `herdr`; `View`, `div` from `gpui-kit`; `v_flex`, `h_flex`, `InputState`, `Input` from `gpui-base`. Programs run: `ssh`, `sh` (remote `ss` script, via `exec(..., {on: machine})`), `mkdir`, `open`, `hc`.

## Watch out

- **A mod only runs while shown.** Herdr does not dock it into an existing layout by itself. Put a block in a layout (clone one first; shipped layouts are read-only), e.g. in the status row: `{ "id": "pf", "type": "block", "size": { "px": 260 }, "content": { "mod": "port-forward" } }`. Without it nothing is forwarded.
- `exec` does **not** reject on a nonzero exit; it resolves `{code, stdout, stderr}`. Every ssh call must check `code` (the mod's `ssh()` helper throws on nonzero), or failed forwards look successful.
- Use the `cx` each callback receives, never one captured from `render`: `on_click((_e, cx) => ...)`. A captured `cx` makes `cx.notify()` do nothing and the Add Port input never appears.
- A popup opened from inside a dialog does not appear under the pointer by default; pass `at` from the event's `position`.
- The ControlMaster must be started with `ControlPersist=yes` (it daemonizes). A plain `-fNM` master dies when `exec` returns.
- Machine names are whatever the user called them and can be renamed; always read them live from `hc machine ls`. Saved `pf.user`/`pf.map` entries are keyed by name and do not follow a rename.
- Needs key-based ssh from this computer to the machine's `target` (`BatchMode`). Password-only machines get no forwards. Forwards bind `127.0.0.1` only.
- Ports already listening when the mod starts are forwarded too. Privileged local ports (below 1024) can fail without root and show as an error row.
- A missing process name is normal for services running as another user.
- `/tmp/herdr-pf/` holds the control sockets. Unix only.

## Done when

- `herdr-app check mods/port-forward` passes, and `herdr-app status` shows no errors with the block in a layout.
- With one ssh machine connected, starting `python3 -m http.server 8801` there makes `curl localhost:8801` return 200 within about 10 seconds, the panel shows an `Auto Forwarded` row with `python3 (<pid>)`, and the bar reads `⇄ Ports · 8801`.
- Stopping that server removes the row and makes `curl localhost:8801` fail.
- Add Port with `9300` adds a `User Forwarded` row and `localhost:9300` starts listening locally (`lsof -iTCP:9300 -sTCP:LISTEN`), even with nothing on the remote.
- Change Local Port on the 8801 row to `28801` makes `curl localhost:28801` return 200, `localhost:8801` stop responding, and the address read `localhost:28801`.
- Stop Forwarding (or ✕) removes a row and closes its local port; a closed auto port does not come back while the remote server keeps running.
- Right-clicking a row opens the three-item menu at the pointer.
- Restarting Herdr does not replay old add/close requests, and remapped ports keep their mapping.

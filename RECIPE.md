# Port Forward

A thin bar at the bottom of the Herdr window that forwards ports from your ssh machines to your computer automatically, like VS Code and Cursor. Click the bar to open a Ports panel listing every forward. Start a dev server or run `aws sso login` on a remote machine and its port appears on `localhost` within a few seconds.

![Port Forward](preview.png)

**What you see:** a 26px bar (`chrome` background, 1px `border` top line, 11.8px `muted` text) showing `⇄ forwarded: 3000, 8080`, or `⇄ auto port forwarding on` when nothing is forwarded. A toast appears for each new forward and for failures.

**Ports panel:** clicking the bar opens a 720x380 dialog (`openOverlay`, same mod with `props.panel`). A table with columns Port, Forwarded Address (`localhost:<port>`, click opens it in the browser), Running Process (`name (pid)` from `ss -p`, blank when the process belongs to another user), Origin (`Auto Forwarded` / `User Forwarded`) and a ✕ button that closes that forward. The last row is a `+ Add Port` button; it reveals a port input (and machine chips when several machines are connected) and forwards even a port nothing listens on yet. A closed auto port stays closed until the remote server stops and starts again. The bar copy owns the forwards; the panel talks to it through shared state (`pf.state`, `pf.req`, `pf.user`).

**How it behaves:**
- Every 3 seconds, for each connected, non-temporary, non-`via` machine from `hc machine ls --json`, it lists listening TCP ports on the machine (`ss -H -ltn`, falling back to `/proc/net/tcp{,6}`), keeping loopback and wildcard binds on ports 1024-65535 (`IGNORE` set at the top excludes more).
- A new port is forwarded to the same local port with `ssh -S <sock> -O forward -L 127.0.0.1:p:127.0.0.1:p <target>`. One ControlMaster (`-fN -o ControlMaster=yes -o ControlPersist=yes -o ControlPath=/tmp/herdr-pf/<id>.sock -o BatchMode=yes`) is started per machine on first need.
- A port that stops listening is cancelled with `-O cancel`. If the local port is taken or ssh refuses, a warning toast shows once.
- On close the master is stopped with `-O exit`.

**Built from:** one mod `port-forward` (`mod.json`: `place: bottom`, `size: 26`). Uses `exec`, `hc`, `theme`, `notify` from `herdr`, and `View`, `div`, `h_flex`. Needs `ssh` with key auth (BatchMode) to the machine's `target`.

**Watch out:**
- `exec` does not reject on a nonzero exit; always check `result.code`.
- A mod only runs while shown. Shipped layouts don't include it, so add a block with `content: { mod: "port-forward" }`, for example beside `workspace-status` in the status row.
- Forwards bind 127.0.0.1 only. Password-only ssh machines are skipped (BatchMode).
- Ports already listening when the mod starts are forwarded too.

**Done when:** `herdr-app check mods/port-forward` passes; with the block in a layout, starting `python3 -m http.server 8765` on an ssh machine makes `curl localhost:8765` return 200 within ~10s, and stopping it makes it fail again.

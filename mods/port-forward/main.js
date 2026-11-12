// Auto port forwarding for ssh machines (like VS Code / Cursor).
// Every few seconds: ask each ssh machine which TCP ports listen on loopback/any,
// and `ssh -L p:127.0.0.1:p` any new one to the same local port, through one
// ControlMaster socket per machine. Ports that stop listening are cancelled.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, hc, home, theme, notify } from "herdr";

const POLL_MS = 3000;
const MIN_PORT = 1024;                 // skip privileged ports (sshd, dns...)
const IGNORE = new Set([]);            // add ports you never want forwarded
const SOCK_DIR = "/tmp/herdr-pf";

const ssh = async (args, timeout) => { const r = await exec("ssh", args, { timeout }); if (r.code !== 0) throw new Error(r.stderr || `ssh exit ${r.code}`); return r; };
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ss on modern Linux; fall back to /proc/net/tcp{,6}. Prints "port" lines.
const REMOTE = `
if command -v ss >/dev/null 2>&1; then
  ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -E '^(127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\*|\\[::1?\\]|::):[0-9]+$' | sed 's/.*://'
else
  cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$4=="0A"{split($2,a,":"); print a[2]}' | while read h; do echo $((16#$h)); done
fi | sort -un
`;

export default class PortForward extends View {
  init(_props, cx) {
    this.m = {};                        // machine name -> { target, ports:Set, error }
    this.busy = false;
    cx.timer.every(POLL_MS, (cx) => this.tick(cx));
    this.tick(cx);
  }

  async close(cx) {
    for (const [, s] of Object.entries(this.m)) {
      if (s.sock) await ssh(["-S", s.sock, "-O", "exit", s.target], 3000).catch(() => {});
    }
  }

  tick(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        const list = (JSON.parse(r.stdout ?? r).machines ?? []).filter((x) => x.state === "connected" && !x.via && !x.temporary);
        await exec("mkdir", ["-p", SOCK_DIR]);
        for (const mc of list) await this.sync(mc, cx);
        cx.notify();
      } catch (e) { console.log("port-forward", String(e)); }
      this.busy = false;
    });
  }

  async sync(mc, cx) {
    const s = (this.m[mc.name] ??= { target: mc.target, ports: new Set(), sock: `${SOCK_DIR}/${mc.id.slice(0, 12)}.sock`, fwd: new Set() });
    let want;
    try {
      const r = await exec("sh", ["-c", REMOTE], { on: mc.name, timeout: 10000 });
      if (r.code !== 0) return;
      want = new Set(r.stdout.split("\n").map(Number).filter((p) => p >= MIN_PORT && p < 65536 && !IGNORE.has(p)));
    } catch (e) { return; }

    // control master (starts on first need; reused afterwards)
    const alive = await ssh(["-S", s.sock, "-O", "check", s.target], 3000).then(() => true, () => false);
    if (!alive) {
      s.fwd.clear();
      if (!want.size) return;
      try {
        await ssh(["-fN", "-o", "ControlMaster=yes", "-o", "ControlPersist=yes", "-o", `ControlPath=${s.sock}`, "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15",
          "-o", "ExitOnForwardFailure=no", s.target], 15000);
      } catch (e) { s.error = String(e); return; }
    }

    for (const p of want) {
      if (s.fwd.has(p)) continue;
      try {
        await ssh(["-S", s.sock, "-O", "forward", "-L", `127.0.0.1:${p}:127.0.0.1:${p}`, s.target], 8000);
        
        s.fwd.add(p);
        notify({ title: `Forwarded port ${p}`, body: `${mc.name} → http://localhost:${p}`, level: "info" });
      } catch (e) {
        
        s.fwd.add(p); // local port busy or refused: don't retry-spam
        notify({ title: `Couldn't forward ${p}`, body: String(e).slice(0, 120), level: "warning" });
      }
    }
    for (const p of [...s.fwd]) {
      if (want.has(p)) continue;
      await ssh(["-S", s.sock, "-O", "cancel", "-L", `127.0.0.1:${p}:127.0.0.1:${p}`, s.target], 5000).catch(() => {});
      s.fwd.delete(p);
    }
    s.ports = s.fwd;
  }

  render() {
    const t = theme();
    const items = Object.entries(this.m).flatMap(([n, s]) => [...s.ports].map((p) => `${p}`));
    return h_flex().size_full().px(14).gap(8).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(11.8).text_color(t.muted)
      .child(div().child(items.length ? `⇄ forwarded: ${items.join(", ")}` : "⇄ auto port forwarding on"));
  }
}

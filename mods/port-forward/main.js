// Auto port forwarding for ssh machines (like VS Code / Cursor), with a Ports panel.
//
// Bar mode (the layout block): every few seconds, asks each ssh machine which TCP ports
// listen on loopback/any and `ssh -L p:127.0.0.1:p`s the new ones to the same local port
// through one ControlMaster per machine. Clicking the bar opens the Ports panel.
// Panel mode (props().panel): a table of forwards (port, address, process, origin) with
// close buttons and an Add Port row. It talks to the bar copy through shared state:
//   pf.state  rows published by the bar        pf.req   requests queued by the panel
//   pf.user   user-forwarded ports (persisted)
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, hc, theme, notify, shared, setShared, props, openOverlay, closeOverlay } from "herdr";

const POLL_MS = 3000;
const MIN_PORT = 1024;                 // auto-forward skips privileged ports
const IGNORE = new Set([]);            // ports never auto-forwarded
const SOCK_DIR = "/tmp/herdr-pf";

const ssh = async (args, timeout) => {
  const r = await exec("ssh", args, { timeout });
  if (r.code !== 0) throw new Error((r.stderr || `ssh exit ${r.code}`).trim());
  return r;
};

// `ss` (with process names) on modern Linux; else /proc/net/tcp, printed in ss's shape.
const REMOTE = `
out=$(ss -H -ltnp 2>/dev/null)
if [ -n "$out" ]; then echo "$out"; else
  cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$4=="0A"{split($2,a,":"); print a[2]}' | sort -u | while read h; do echo "LISTEN 0 0 0.0.0.0:$((16#$h)) 0.0.0.0:*"; done
fi
`;

function parseListening(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    const tok = line.trim().split(/\s+/);
    const m = (tok[3] ?? "").match(/^(?:127\.0\.0\.1|0\.0\.0\.0|\*|\[::1?\]|::):(\d+)$/);
    if (!m) continue;
    const p = Number(m[1]);
    const pm = tok.slice(5).join(" ").match(/\("([^"]+)",pid=(\d+)/);
    if (!out.has(p) || pm) out.set(p, pm ? `${pm[1]} (${pm[2]})` : "");
  }
  return out;
}

const fwdSpec = (p) => `127.0.0.1:${p}:127.0.0.1:${p}`;

export default class PortForward extends View {
  init(_props, cx) {
    this.panel = Boolean(props()?.panel);
    if (this.panel) return this.initPanel(cx);
    this.m = {};                         // machine -> { target, sock, fwd: Map port -> {origin, error}, closed: Set, listening: Map }
    // requests persist in shared state: ones queued before this copy started are already handled
    this.busy = false; this.again = false; this.seen = new Set((shared("pf.req") ?? []).map((r) => r.id)); this.last = "";
    this.n = 0;
    cx.timer.every(500, (cx) => {
      this.n += 500;
      const fresh = (shared("pf.req") ?? []).filter((r) => !this.seen.has(r.id));
      if (fresh.length) { for (const r of fresh) { this.seen.add(r.id); this.applyReq(r); } this.kick(cx); }
      else if (this.n % POLL_MS === 0) this.kick(cx);
    });
    this.kick(cx);
  }

  // ---------- bar side ----------
  async close() {
    if (this.panel) return;
    for (const s of Object.values(this.m ?? {})) await ssh(["-S", s.sock, "-O", "exit", s.target], 3000).catch(() => {});
  }

  applyReq(r) {
    const users = (shared("pf.user") ?? []).filter((u) => !(u.machine === r.machine && u.port === r.port));
    const s = this.m[r.machine];
    if (r.op === "add") {
      users.push({ machine: r.machine, port: r.port });
      const f = s?.fwd.get(r.port);
      if (f) { f.origin = "user"; f.error = null; }
      s?.closed.delete(r.port);
    } else if (r.op === "close") {
      s?.closed.add(r.port);
      s?.drop.add(r.port);
    }
    setShared("pf.user", users);
  }

  kick(cx) {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        do {
          this.again = false;
          const r = await hc(["machine", "ls", "--json"]);
          const list = (JSON.parse(r.stdout ?? r).machines ?? []).filter((x) => x.state === "connected" && !x.via && !x.temporary);
          await exec("mkdir", ["-p", SOCK_DIR]);
          for (const mc of list) await this.sync(mc);
          this.publish(list.map((x) => x.name));
          cx.notify();
        } while (this.again);
      } catch (e) { console.log("port-forward", String(e)); }
      this.busy = false;
    });
  }

  publish(machines) {
    const rows = [];
    for (const [machine, s] of Object.entries(this.m)) {
      if (!machines.includes(machine)) continue;
      for (const [port, f] of s.fwd) rows.push({ machine, port, proc: s.listening.get(port) ?? "", origin: f.origin, error: f.error ?? null });
    }
    rows.sort((a, b) => a.port - b.port);
    const state = { rows, machines };
    const j = JSON.stringify(state);
    if (j !== this.last) { this.last = j; setShared("pf.state", state); }
  }

  async sync(mc) {
    let s = this.m[mc.name];
    const fresh = !s;
    s ??= this.m[mc.name] = { target: mc.target, sock: `${SOCK_DIR}/${mc.id.slice(0, 12)}.sock`, fwd: new Map(), closed: new Set(), drop: new Set(), listening: new Map() };

    let listening;
    try {
      const r = await exec("sh", ["-c", REMOTE], { on: mc.name, timeout: 10000 });
      if (r.code !== 0) return;
      listening = parseListening(r.stdout);
    } catch { return; }
    s.listening = listening;
    for (const p of [...s.closed]) if (!listening.has(p)) s.closed.delete(p);   // closed ports reopen once they stop and restart

    const users = new Set((shared("pf.user") ?? []).filter((u) => u.machine === mc.name).map((u) => u.port));
    const want = new Map();                                                      // port -> origin
    for (const p of listening.keys()) if (p >= MIN_PORT && !IGNORE.has(p) && !s.closed.has(p)) want.set(p, "auto");
    for (const p of users) want.set(p, "user");

    let alive = !fresh && await ssh(["-S", s.sock, "-O", "check", s.target], 3000).then(() => true, () => false);
    if (fresh) await ssh(["-S", s.sock, "-O", "exit", s.target], 3000).catch(() => {}); // drop a master left by an earlier run
    if (!alive) {
      s.fwd.clear();
      if (!want.size) return;
      try {
        await ssh(["-fN", "-o", "ControlMaster=yes", "-o", "ControlPersist=yes", "-o", `ControlPath=${s.sock}`,
          "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ExitOnForwardFailure=no", s.target], 15000);
      } catch (e) { return; }
    }

    for (const p of s.drop) {                                                    // closed from the panel
      if (s.fwd.has(p)) await ssh(["-S", s.sock, "-O", "cancel", "-L", fwdSpec(p), s.target], 5000).catch(() => {});
      s.fwd.delete(p);
    }
    s.drop.clear();

    for (const [p, origin] of want) {
      const f = s.fwd.get(p);
      if (f) { f.origin = origin; continue; }
      try {
        await ssh(["-S", s.sock, "-O", "forward", "-L", fwdSpec(p), s.target], 8000);
        s.fwd.set(p, { origin });
        if (origin === "auto") notify({ title: `Forwarded port ${p}`, body: `${mc.name} → localhost:${p}`, level: "info" });
      } catch (e) {
        s.fwd.set(p, { origin, error: String(e.message ?? e).slice(0, 90) });
        notify({ title: `Couldn't forward ${p}`, body: String(e.message ?? e).slice(0, 120), level: "warning" });
      }
    }
    for (const [p, f] of [...s.fwd]) {                                           // auto forwards follow the remote server
      if (want.has(p)) continue;
      await ssh(["-S", s.sock, "-O", "cancel", "-L", fwdSpec(p), s.target], 5000).catch(() => {});
      s.fwd.delete(p);
    }
  }

  // ---------- panel side ----------
  initPanel(cx) {
    this.adding = false;
    this.machine = null;
    this.error = "";
    this.input = InputState.new({ value: "" });
    this.input.on("submit", () => this.submit());
    this.input.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
    this.handle = cx.focus_handle();
  }

  send(op, machine, port) {
    const q = (shared("pf.req") ?? []).slice(-20);
    q.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, op, machine, port });
    setShared("pf.req", q);
  }

  submit() {
    const state = shared("pf.state") ?? { rows: [], machines: [] };
    const port = Number(String(this.input.value()).trim().replace(/^.*:/, ""));
    const machine = this.machine && state.machines.includes(this.machine) ? this.machine : state.machines[0];
    if (!machine) { this.error = "No ssh machine connected"; return; }
    if (!Number.isInteger(port) || port < 1 || port > 65535) { this.error = "Enter a port from 1 to 65535"; return; }
    this.send("add", machine, port);
    this.input.set_value?.("");
    this.adding = false;
  }

  renderPanel(cx) {
    const t = theme();
    const st = shared("pf.state") ?? { rows: [], machines: [] };
    const multi = st.machines.length > 1;
    const W = { port: 96, addr: 170, origin: 130, x: 30 };
    const cell = (w, el) => (w ? el.w(w).flex_none() : el.flex_1().min_w(0)).px(8).truncate();
    const head = h_flex().h(30).items_center().border_b(1).border_color(t.border).text_size(11.5).text_color(t.dim)
      .child(cell(W.port, div().child("Port"))).child(cell(W.addr, div().child("Forwarded Address")))
      .child(cell(0, div().child("Running Process"))).child(cell(W.origin, div().child("Origin"))).child(div().w(W.x).flex_none());
    const rows = st.rows.map((r) => {
      const url = `localhost:${r.port}`;
      return h_flex().id(`r-${r.machine}-${r.port}`).h(34).items_center().text_size(12.5).text_color(t.foreground)
        .hover((s) => s.bg(t.raised))
        .child(cell(W.port, h_flex().gap(6).items_center().child(div().child(String(r.port)))
          .when(multi, (el) => el.child(div().text_size(10.5).text_color(t.dim).truncate().child(r.machine)))))
        .child(cell(W.addr, r.error
          ? div().text_color(t.blocked).child(r.error)
          : div().id(`o-${r.machine}-${r.port}`).text_color(t.accent).cursor_pointer().hover((s) => s.opacity(0.8))
              .on_click(() => exec("open", [`http://${url}`])).child(url)))
        .child(cell(0, div().text_color(t.muted).child(r.proc)))
        .child(cell(W.origin, div().text_color(t.muted).child(r.origin === "user" ? "User Forwarded" : "Auto Forwarded")))
        .child(div().id(`x-${r.machine}-${r.port}`).w(W.x).flex_none().h_full().flex().items_center().justify_center()
          .text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click(() => this.send("close", r.machine, r.port)).child("✕"));
    });
    const empty = st.rows.length ? null : div().px(8).py(18).text_size(12).text_color(t.dim)
      .child(st.machines.length ? "No forwarded ports yet. Start a server on a remote machine, or add one." : "Connect an ssh machine to forward its ports.");
    const addBtn = h_flex().id("pf-add").h(30).px(12).items_center().rounded(8).border_1().border_color(t.input).bg(t.raised)
      .text_size(12.5).text_color(t.foreground).cursor_pointer().hover((s) => s.opacity(0.88))
      .on_click(() => { this.adding = true; this.input.focus(); cx.notify(); }).child("+ Add Port");
    const chips = multi ? h_flex().gap(6).children(st.machines.map((m) => {
      const on = (this.machine ?? st.machines[0]) === m;
      return div().id(`m-${m}`).h(26).px(8).flex().items_center().rounded(6).text_size(11.5).cursor_pointer()
        .bg(on ? t.solid : t.raised).text_color(on ? t.solid_foreground : t.muted)
        .on_click(() => { this.machine = m; cx.notify(); }).child(m);
    })) : null;
    const addRow = h_flex().gap(8).items_center()
      .child(Input.new(this.input).w(160).h(30).px(10).rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground))
      .when(Boolean(chips), (el) => el.child(chips))
      .child(h_flex().id("pf-ok").h(30).px(12).items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12.5)
        .cursor_pointer().on_click(() => { this.submit(); cx.notify(); }).child("Forward"))
      .child(div().id("pf-cancel").text_size(12).text_color(t.dim).cursor_pointer().on_click(() => { this.adding = false; cx.notify(); }).child("Cancel"))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.error)));
    return v_flex().id("pf-panel").track_focus(this.handle).size_full().p(18).gap(8).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { if (this.adding) { this.adding = false; cx.notify(); } else closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("Ports"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().child(head).children(rows).when(Boolean(empty), (el) => el.child(empty)))
      .child(this.adding ? addRow : h_flex().child(addBtn));
  }

  // ---------- render ----------
  render(cx) {
    if (this.panel) return this.renderPanel(cx);
    const t = theme();
    const st = shared("pf.state") ?? { rows: [] };
    const ports = [...new Set(st.rows.map((r) => r.port))];
    const text = ports.length ? `⇄ Ports · ${ports.join(", ")}` : "⇄ Ports";
    return h_flex().id("pf-bar").size_full().px(14).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(11.8).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click(() => openOverlay({ mod: "port-forward", props: { panel: true }, kind: "dialog", width: 720, height: 380 }))
      .child(div().truncate().child(text));
  }
}

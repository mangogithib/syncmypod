/*
  The GUI's one script.

  Two conventions carried over from the web tool, both deliberate.

  Every DOM node is built and filled through `textContent`. Track titles and
  error messages come from search results and from other people's servers, and
  building them into an HTML string would make escaping something to remember
  rather than something the design makes impossible.

  The page holds no state of its own beyond what it is drawing. The engine is
  the authority on what is happening; this polls for events and renders them, so
  a reload mid-sync picks the run back up rather than losing it.
*/

const state = { since: 0, timer: null, tracks: new Map(), total: 0 };

const el = (id) => document.getElementById(id);

/* -- plumbing ------------------------------------------------------------ */

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json();
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function clear(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function bytes(value) {
  if (!value && value !== 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

function row(list, label, value) {
  list.append(node("dt", null, label), node("dd", null, value));
}

/* -- the two status cards ------------------------------------------------ */

async function refreshState() {
  let data;
  try {
    data = await api("/api/state");
  } catch (error) {
    renderProblem(el("ipod-body"), error.message);
    return null;
  }

  el("server-label").textContent = data.paired ? data.server : "Not paired";
  lastChoices = data.qualityChoices || lastChoices;
  renderIpod(data);
  renderLibrary(data);
  renderQuality(data);

  // Both halves have to be present before a sync can do anything: an iPod to
  // write to, and a pairing to know what belongs on it.
  const ready = Boolean(data.paired && data.ipod && !data.running);
  el("btn-sync").disabled = !ready;
  el("btn-check").disabled = !ready;
  return data;
}

function renderIpod(data) {
  const body = el("ipod-body");
  clear(body);

  if (data.ipodError) {
    renderProblem(body, data.ipodError);
    return;
  }
  if (!data.ipod) {
    body.append(node("p", "muted", "No iPod detected."));
    body.append(
      node("p", "subtle", "Plug one in and make sure it appears as a drive.")
    );
    return;
  }

  const ipod = data.ipod;
  body.append(node("p", "device-name", ipod.name || ipod.model || "iPod"));
  body.append(node("p", "subtle", ipod.model || ""));

  const rows = node("dl", "rows");
  row(rows, "Mounted at", ipod.mount);
  row(rows, "Generation", ipod.generation || "unknown");
  row(rows, "Free", `${bytes(ipod.freeBytes)} of ${bytes(ipod.capacityBytes)}`);
  body.append(rows);

  if (ipod.capacityBytes) {
    const used = 1 - ipod.freeBytes / ipod.capacityBytes;
    const meter = node("div", "meter");
    const fill = node("div", "meter-fill");
    fill.style.width = `${Math.max(0, Math.min(1, used)) * 100}%`;
    meter.append(fill);
    body.append(meter);
  }

  // Named rather than shown as a tick. When a sync goes wrong on an unusual
  // device, which signature scheme applies is the first thing worth knowing.
  const signature = node(
    "span",
    `badge ${ipod.needsSignature ? "badge-warn" : "badge-ok"}`,
    ipod.needsSignature
      ? `signed database (${(ipod.checksumType || "").toLowerCase()})`
      : "no signature needed"
  );
  const line = node("p", "subtle");
  line.style.marginTop = "12px";
  line.append(signature);
  body.append(line);
}

function renderLibrary(data) {
  const body = el("library-body");
  clear(body);

  if (!data.paired) {
    body.append(node("p", "muted", "This computer is not paired with a library."));
    const how = node("p", "subtle", "Pair it from a terminal: ");
    how.append(node("code", null, "syncmypod pair <server> <code>"));
    body.append(how);
    return;
  }

  body.append(node("p", "device-name", data.deviceName || "This computer"));
  body.append(node("p", "subtle", data.server));

  const rows = node("dl", "rows");
  row(rows, "Audio tools", data.ffmpeg.found ? "ready" : "missing");
  body.append(rows);

  if (!data.ffmpeg.found) {
    body.append(
      node(
        "p",
        "notice notice-danger",
        "ffmpeg was not found, so nothing can be downloaded or converted."
      )
    );
  }
}

/* -- audio quality ------------------------------------------------------- */

/*
  The settings are written back the moment a control changes, with no Save
  button. There are five of them and they are all cheap to reverse, so a save
  step would be ceremony - and a form you can leave half-applied is worse than
  one that just keeps up.
*/

function renderQuality(data) {
  const quality = data.quality;
  const choices = data.qualityChoices;
  if (!quality || !choices) return;

  el("quality-summary").textContent = summariseQuality(quality);

  const presets = el("quality-presets");
  clear(presets);
  for (const name of choices.presets) {
    const button = node("button", "preset", name);
    button.type = "button";
    button.setAttribute("aria-pressed", String(quality.name === name));
    button.addEventListener("click", () => saveQuality({ preset: name }));
    presets.append(button);
  }

  fillSelect(el("quality-codec"), choices.codecs.map((c) => [c, c.toUpperCase()]), quality.codec);
  fillSelect(
    el("quality-bitrate"),
    choices.bitrates.map((b) => [b, `${b} kbps`]),
    quality.maxBitrateKbps
  );
  fillSelect(
    el("quality-floor"),
    choices.sourceFloors.map((b) => [b, b ? `${b} kbps` : "accept anything"]),
    quality.minSourceKbps
  );

  // Phrased as what the user wants rather than as the internal flag, which is
  // the negative of it.
  el("quality-best-source").checked = !quality.preferNoReencode;
  el("quality-shrink").checked = Boolean(quality.shrinkToCeiling);
}

function summariseQuality(quality) {
  const parts = [`${quality.name} · ${quality.codec.toUpperCase()} up to ${quality.maxBitrateKbps}kbps`];
  if (quality.minSourceKbps) parts.push(`refusing below ${quality.minSourceKbps}kbps`);
  if (!quality.preferNoReencode) parts.push("best source");
  if (quality.shrinkToCeiling) parts.push("shrinking larger files");
  return parts.join(" · ");
}

function fillSelect(select, options, selected) {
  clear(select);
  for (const [value, label] of options) {
    const option = node("option", null, label);
    option.value = String(value);
    if (String(value) === String(selected)) option.selected = true;
    select.append(option);
  }
}

async function saveQuality(changes) {
  try {
    const result = await api("/api/quality", {
      method: "POST",
      body: JSON.stringify(changes),
    });
    if (result.saved) renderQuality({ quality: result.quality, qualityChoices: lastChoices });
  } catch (error) {
    el("quality-summary").textContent = `Could not save: ${error.message}`;
  }
}

let lastChoices = null;

function renderProblem(body, message) {
  clear(body);
  body.append(node("p", "notice notice-danger", message));
}

/* -- running ------------------------------------------------------------- */

async function start({ dryRun }) {
  state.since = 0;
  state.tracks.clear();
  state.total = 0;

  clear(el("track-list"));
  clear(el("plan-stats"));
  clear(el("plan-removals"));
  clear(el("summary-body"));
  el("summary-panel").hidden = true;
  el("plan-panel").hidden = true;
  el("run-panel").hidden = dryRun;
  el("progress-track").hidden = true;
  el("progress-count").textContent = "";

  setRunning(true);
  try {
    const result = await api("/api/sync", {
      method: "POST",
      body: JSON.stringify({
        dryRun,
        remove: el("opt-remove").checked,
      }),
    });
    if (!result.started) throw new Error(result.error || "Could not start.");
  } catch (error) {
    setRunning(false);
    showSummary({ status: "error", message: error.message, failed: [] });
    return;
  }
  poll();
}

function setRunning(running) {
  el("btn-sync").disabled = running;
  el("btn-check").disabled = running;
  el("btn-cancel").hidden = !running;
}

function poll() {
  clearTimeout(state.timer);
  state.timer = setTimeout(async () => {
    let data;
    try {
      data = await api(`/api/events?since=${state.since}`);
    } catch {
      // A dropped request mid-sync is not worth surfacing; the next poll will
      // almost certainly succeed, and the run is not affected either way.
      poll();
      return;
    }

    for (const event of data.events) {
      state.since = Math.max(state.since, event.seq + 1);
      handle(event);
    }

    if (data.running) {
      poll();
      return;
    }

    setRunning(false);
    if (data.error) showSummary({ status: "error", message: data.error, failed: [] });
    else if (data.summary) showSummary(data.summary);
    refreshState();
  }, 600);
}

function handle(event) {
  switch (event.kind) {
    case "plan":
      renderPlan(event);
      break;
    case "track":
      state.total = event.total;
      trackRow(event.id, event.label).className = "track track-working";
      setState(event.id, "working…");
      el("progress-track").hidden = false;
      el("progress-count").textContent = `${event.index} of ${event.total}`;
      el("progress-fill").style.width = `${((event.index - 1) / event.total) * 100}%`;
      break;
    case "track-ready": {
      const parts = [event.format, event.bitrate ? `${event.bitrate}kbps` : null, bytes(event.size)];
      markDone(event.id, parts.filter(Boolean).join(" · "));
      break;
    }
    case "track-failed":
      markFailed(event.id, event.error);
      break;
    case "backup":
      note("Backing up the iPod…");
      break;
    case "writing":
      note(`Writing ${event.count} track(s) to the iPod…`);
      break;
    case "playlists":
      note(`Writing ${event.count} playlist(s)…`);
      break;
    case "removing":
      note(`Removing ${event.count} track(s)…`);
      break;
    case "artwork":
      note(`Building cover art for ${event.count} track(s)…`);
      break;
    case "cancelling":
      note("Stopping after the current track…");
      break;
    default:
      break;
  }
}

function renderPlan(event) {
  el("plan-panel").hidden = false;
  const stats = el("plan-stats");
  clear(stats);

  const entries = [
    ["To download", event.toDownload],
    ["Already there", event.alreadyPresent + event.adopted],
    ["Playlists", event.playlists],
  ];
  if (event.removals.length) entries.push(["To remove", event.removals.length]);
  if (event.artworkMissing) entries.push(["Missing art", event.artworkMissing]);
  if (event.excluded) entries.push(["Unresolved", event.excluded]);

  for (const [label, value] of entries) {
    const stat = node("div", "stat");
    stat.append(node("span", "stat-value", value), node("span", "stat-label", label));
    stats.append(stat);
  }

  const removals = el("plan-removals");
  clear(removals);
  if (event.removals.length) {
    removals.append(
      node(
        "p",
        "notice notice-warn",
        el("opt-remove").checked
          ? "These will be deleted from the iPod:"
          : "These are on the iPod but no longer in the library. Tick the option above to remove them."
      )
    );
    const list = node("ul", "removal-list");
    for (const removal of event.removals) list.append(node("li", null, removal.label));
    removals.append(list);
  }

  if (event.tracks.length) {
    el("run-panel").hidden = false;
    for (const track of event.tracks) trackRow(track.id, track.label);
  }
}

function trackRow(id, label) {
  let row = state.tracks.get(id);
  if (row) return row;
  row = node("li", "track");
  row.append(node("span", "track-label", label), node("span", "track-state", "waiting"));
  state.tracks.set(id, row);
  el("track-list").append(row);
  return row;
}

function setState(id, text) {
  const row = state.tracks.get(id);
  if (row) row.querySelector(".track-state").textContent = text;
}

function markDone(id, detail) {
  const row = state.tracks.get(id);
  if (!row) return;
  row.className = "track track-done";
  row.querySelector(".track-state").textContent = detail;
}

function markFailed(id, message) {
  const row = state.tracks.get(id);
  if (!row) return;
  row.className = "track track-failed";
  row.querySelector(".track-state").textContent = "failed";
  if (message) row.append(node("span", "track-error", message));
}

function note(text) {
  el("progress-count").textContent = text;
}

function showSummary(summary) {
  const panel = el("summary-panel");
  const body = el("summary-body");
  panel.hidden = false;
  clear(body);

  el("progress-fill").style.width = "100%";

  if (summary.status === "error") {
    body.append(node("p", "notice notice-danger", summary.message));
    return;
  }

  if (summary.dryRun) {
    body.append(
      node(
        "p",
        "notice notice-warn",
        summary.toDownload
          ? `Nothing was written. ${summary.toDownload} track(s) would be downloaded.`
          : "Nothing was written, and nothing is missing."
      )
    );
    return;
  }

  const parts = [`${summary.synced} synced`];
  if (summary.failed.length) parts.push(`${summary.failed.length} failed`);
  if (summary.removed) parts.push(`${summary.removed} removed`);
  if (summary.playlists) parts.push(`${summary.playlists} playlist(s) written`);
  if (summary.artwork) parts.push(`${summary.artwork} with cover art`);

  const tone = summary.failed.length ? "notice-warn" : "notice-ok";
  body.append(node("p", `notice ${tone}`, parts.join(" · ")));

  if (summary.message) body.append(node("p", "subtle", summary.message));

  // Artwork failing is not a failed sync - the music is on the device - but it
  // is the kind of thing that would otherwise look like it silently did nothing.
  if (summary.artworkError) {
    body.append(
      node(
        "p",
        "notice notice-warn",
        `The music synced, but the cover art did not: ${summary.artworkError}`
      )
    );
  }

  if (summary.failed.length) {
    const list = node("ul", "failures");
    for (const failure of summary.failed) {
      const item = node("li");
      item.append(node("div", null, failure.label));
      if (failure.error) item.append(node("div", "subtle", failure.error));
      list.append(item);
    }
    body.append(list);
  }

  if (summary.excluded) {
    body.append(
      node(
        "p",
        "notice notice-warn",
        `${summary.excluded} track(s) were skipped because their metadata is not confirmed. Resolve them in the web interface.`
      )
    );
  }
}

/* -- wiring -------------------------------------------------------------- */

el("quality-toggle").addEventListener("click", () => {
  const form = el("quality-form");
  form.hidden = !form.hidden;
  el("quality-toggle").setAttribute("aria-expanded", String(!form.hidden));
  el("quality-toggle").textContent = form.hidden ? "Change" : "Done";
});

el("quality-codec").addEventListener("change", (e) => saveQuality({ codec: e.target.value }));
el("quality-bitrate").addEventListener("change", (e) =>
  saveQuality({ maxBitrateKbps: Number(e.target.value) })
);
el("quality-floor").addEventListener("change", (e) =>
  saveQuality({ minSourceKbps: Number(e.target.value) })
);
el("quality-best-source").addEventListener("change", (e) =>
  saveQuality({ preferNoReencode: !e.target.checked })
);
el("quality-shrink").addEventListener("change", (e) =>
  saveQuality({ shrinkToCeiling: e.target.checked })
);

el("btn-sync").addEventListener("click", () => start({ dryRun: false }));
el("btn-check").addEventListener("click", () => start({ dryRun: true }));
el("btn-cancel").addEventListener("click", async () => {
  el("btn-cancel").disabled = true;
  await api("/api/cancel", { method: "POST" }).catch(() => {});
});

refreshState().then((data) => {
  // A sync started from the terminal, or a page reloaded mid-run, should pick
  // up where it is rather than showing an idle screen next to a busy engine.
  if (data && data.running) {
    setRunning(true);
    poll();
  }
});

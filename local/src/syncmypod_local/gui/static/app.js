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
  // Reflected from the stored setting rather than left at the markup's default,
  // so a box the user unticked last time is still unticked.
  if (typeof data.backupBeforeSync === "boolean") {
    el("opt-backup").checked = data.backupBeforeSync;
  }
  renderIpod(data);
  renderLibrary(data);
  renderYouTube(data);

  // Both halves have to be present before a sync can do anything: an iPod to
  // write to, and a pairing to know what belongs on it.
  const ready = Boolean(data.paired && data.ipod && !data.running);
  el("btn-sync").disabled = !ready;
  el("btn-check").disabled = !ready;
  // Needs a library but no device: it searches, it does not write anything.
  el("btn-matches").disabled = Boolean(!data.paired || data.running);
  // Ejecting needs an iPod but not a pairing: getting the device back safely is
  // not something that should depend on the server being reachable.
  el("btn-eject").disabled = Boolean(!data.ipod || data.running);
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
    renderPairingForm(body);
    return;
  }

  body.append(node("p", "device-name", data.deviceName || "This computer"));
  body.append(node("p", "subtle", data.server));

  const rows = node("dl", "rows");
  row(rows, "Audio tools", data.ffmpeg.found ? "ready" : "missing");
  body.append(rows);

  const unpair = node("button", "link-button", "Unpair this computer");
  unpair.type = "button";
  unpair.style.marginTop = "12px";
  unpair.addEventListener("click", async () => {
    unpair.disabled = true;
    await api("/api/unpair", { method: "POST", body: "{}" }).catch(() => {});
    refreshState();
  });
  body.append(unpair);

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

/* -- pairing ------------------------------------------------------------- */

/*
  Pairing, in the page.

  It was a terminal command, which meant the application could not be used at
  all without one - a poor first instruction for something whose whole point is
  that it has a window. The password is still never involved: a short code is
  traded for a device token, exactly as the command did it.
*/

function renderPairingForm(body) {
  body.append(node("p", "device-name", "Not paired"));
  body.append(
    node(
      "p",
      "subtle",
      "Generate a pairing code in your library's web interface, under Devices."
    )
  );

  const server = node("input", "input-field");
  server.type = "text";
  server.placeholder = "your-server.example.org:8444";
  server.autocomplete = "off";
  server.spellcheck = false;

  const code = node("input", "input-field");
  code.type = "text";
  code.placeholder = "ABCD1234";
  code.autocomplete = "off";
  code.spellcheck = false;
  // The codes are printed in capitals and the alphabet excludes the ambiguous
  // characters, so accepting any case and showing it back uppercased is free.
  code.style.textTransform = "uppercase";

  const button = node("button", "button button-small button-primary", "Pair");
  button.type = "submit";

  const message = node("p", "subtle");
  const form = node("form", "pair-form");
  form.append(labelled("Server address", server), labelled("Code", code), button, message);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    button.textContent = "Pairing…";
    message.className = "subtle";
    message.textContent = "";
    try {
      const result = await api("/api/pair", {
        method: "POST",
        body: JSON.stringify({ server: server.value, code: code.value }),
      });
      if (!result.paired) throw new Error(result.error || "Could not pair.");
      refreshState();
      return;
    } catch (error) {
      message.className = "notice notice-danger";
      message.textContent = error.message;
    }
    button.disabled = false;
    button.textContent = "Pair";
  });

  body.append(form);
}

function labelled(text, control) {
  const wrapper = node("label", "field");
  wrapper.append(node("span", "field-label", text), control);
  return wrapper;
}

/* -- audio source -------------------------------------------------------- */

/*
  Signed out, YouTube hands over one AAC stream at about 128kbps; a Premium
  account is offered the same recording at 256. That difference is the only
  thing this card exists to communicate, so the bitrate is the headline and
  everything else is support for it.

  The bitrate is not fetched on page load. Asking YouTube costs a request and a
  couple of seconds, and the page should open immediately - so it shows whether
  a session is saved, and checks only when asked.
*/

let youtubeState = { signedIn: false, detail: null, premium: false };

function renderYouTube(data) {
  if (data && data.youtube) {
    youtubeState = { ...youtubeState, ...data.youtube };
  }

  const body = el("youtube-body");
  clear(body);

  const headline = youtubeState.detail
    ? youtubeState.detail
    : youtubeState.signedIn
      ? "Signed in"
      : "Opus, converted to 256kbps AAC";
  body.append(node("p", "headline", headline));

  body.append(
    node(
      "p",
      "subtle",
      youtubeState.signedIn
        ? "Using your saved YouTube session."
        : "Highest quality YouTube offers for free. Premium adds a 256kbps AAC stream that needs no conversion."
    )
  );

  const actions = node("div", "card-actions");

  if (youtubeState.signedIn) {
    const check = node("button", "button button-small", "Check quality");
    check.type = "button";
    check.addEventListener("click", () => youtubeCall(check, "/api/youtube/check"));
    actions.append(check);

    const out = node("button", "button button-small", "Sign out");
    out.type = "button";
    out.addEventListener("click", async () => {
      out.disabled = true;
      await api("/api/youtube/sign-out", { method: "POST", body: "{}" }).catch(() => {});
      youtubeState = { ...youtubeState, signedIn: false, detail: null, premium: false };
      renderYouTube(null);
    });
    actions.append(out);
  } else {
    // No browser picker. Whichever browser is signed in to YouTube is found by
    // trying them, because "which browser are you signed in to YouTube in" is a
    // question most people cannot answer and should not be asked.
    const signIn = node("button", "button button-small button-primary", "Sign in to YouTube");
    signIn.type = "button";
    // This can take minutes: if no installed browser can be read, the server
    // opens a browser window and waits for the sign-in to finish in it. The
    // label has to say that, or a window appearing looks like something broke.
    signIn.addEventListener("click", () =>
      youtubeCall(signIn, "/api/youtube/sign-in", {}, "Waiting for sign-in…")
    );
    actions.append(signIn);

    body.append(
      node(
        "p",
        "subtle",
        "If this computer's browser cannot hand over its session, a browser window opens - sign in to YouTube there and leave it to close itself."
      )
    );

    // The way out when reading the browser cannot work. On Windows, Chromium
    // seals its cookies and Firefox may not be installed, which leaves nothing
    // for the button above to find however many times it is pressed.
    const useFile = node("button", "button button-small", "Use a cookies.txt file");
    useFile.type = "button";
    useFile.addEventListener("click", () => {
      const panel = el("youtube-cookie-file");
      panel.hidden = !panel.hidden;
      if (!panel.hidden) panel.querySelector("input").focus();
    });
    actions.append(useFile);
  }

  body.append(actions);

  if (!youtubeState.signedIn) {
    body.append(cookieFilePanel());
  }

  if (youtubeState.error) {
    body.append(node("p", "notice notice-warn", youtubeState.error));
  }
  if (youtubeState.signedIn && youtubeState.detail && !youtubeState.premium) {
    body.append(
      node(
        "p",
        "subtle",
        "256kbps needs an active YouTube Music Premium subscription on that account."
      )
    );
  }
}


// A path box rather than a file picker: this page is served to the browser from
// the user's own machine, and a picked file arrives as bytes with its real path
// stripped, which is precisely the thing needed here.
function cookieFilePanel() {
  const panel = node("div", "cookie-file");
  panel.id = "youtube-cookie-file";
  panel.hidden = true;

  panel.append(
    node(
      "p",
      "subtle",
      "Export cookies.txt from any browser while signed in to YouTube, then give the path to it here."
    )
  );

  const row = node("div", "card-actions");
  const input = node("input", "input-field");
  input.type = "text";
  input.placeholder = "C:\Users\you\Downloads\cookies.txt";
  input.setAttribute("aria-label", "Path to a cookies.txt file");

  const use = node("button", "button button-small button-primary", "Use this file");
  use.type = "button";
  const submit = () => youtubeCall(use, "/api/youtube/use-cookies", { path: input.value });
  use.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });

  row.append(input, use);
  panel.append(row);
  return panel;
}

async function youtubeCall(button, path, payload = {}, busyLabel = "Working…") {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify(payload) });
    youtubeState = { ...youtubeState, ...result };
    // A refused sign-in returns saved:false with a reason, and must not leave
    // the card claiming a session exists.
    if (result.saved === false) youtubeState.signedIn = false;
  } catch (error) {
    youtubeState = { ...youtubeState, error: error.message };
  } finally {
    button.disabled = false;
    button.textContent = original;
    renderYouTube(null);
  }
}

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
        backup: el("opt-backup").checked,
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
  // Never while a run is writing to it.
  el("btn-eject").disabled = running;
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
    // The progress line held whatever the last step said - "Building cover art
    // for 423 track(s)..." - and nothing ever replaced it, so a finished run
    // still read as one in progress and the only way to tell was to notice the
    // Result card underneath. Say plainly that it has stopped.
    finishProgress(data.summary, data.error);
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
    case "database":
      note("Setting this iPod up: it has no library database yet…");
      break;
    case "backup":
      note("Backing up the iPod…");
      break;
    case "backup-skipped":
      note("Backup skipped - nothing will be saved to restore from.");
      break;
    case "checking":
      note(
        `Looking for ${event.total} track(s)` +
          (event.skipped ? `; ${event.skipped} already have a source link.` : ".")
      );
      break;
    case "no-match":
      note(`No audio found for ${event.label}`);
      break;
    case "reporting":
      note(`Sending ${event.count} result(s) to the library...`);
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

// What the progress line says once there is nothing left to do.
function finishProgress(summary, error) {
  el("progress-fill").style.width = "100%";
  if (error) {
    note("Stopped with an error.");
    return;
  }
  if (!summary) {
    note("Finished.");
    return;
  }
  if (summary.dryRun) {
    note("Check finished - nothing was written.");
    return;
  }
  const failed = (summary.failed || []).length;
  const parts = [`${summary.synced} synced`];
  if (failed) parts.push(`${failed} failed`);
  if (summary.removed) parts.push(`${summary.removed} removed`);
  const stopped = summary.status === "cancelled" ? "Stopped" : "Finished";
  note(`${stopped}: ${parts.join(", ")}. Safe to eject.`);
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

  // The match check reports something different from a sync: not what was
  // written, but what could be found at all.
  if (summary.kind === "matches") {
    if (summary.status === "blocked") {
      body.append(node("p", "notice notice-danger", summary.message));
      return;
    }
    body.append(
      node(
        "p",
        summary.missing.length ? "notice notice-warn" : "notice notice-ok",
        summary.checked === 0
          ? summary.message || "Nothing needed checking."
          : `Checked ${summary.checked}. Found ${summary.found}, ` +
            `${summary.missing.length} with no audio available.` +
            (summary.skipped ? ` ${summary.skipped} already had a link.` : "")
      )
    );
    if (summary.missing.length) {
      const list = node("ol", "tracks");
      for (const entry of summary.missing) {
        const row = node("li", "track track-failed");
        row.append(node("span", "track-name", entry.label));
        row.append(node("span", "track-state", "not found"));
        list.append(row);
      }
      body.append(list);
      body.append(
        node(
          "p",
          "muted",
          "Paste a source link for any of these in the web interface and they will sync."
        )
      );
    }
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

el("btn-sync").addEventListener("click", () => start({ dryRun: false }));
el("btn-check").addEventListener("click", () => start({ dryRun: true }));

// Needs no iPod: it answers "which of these can be found at all", which is
// worth knowing before the device is anywhere near the machine.
el("btn-matches").addEventListener("click", async () => {
  state.since = 0;
  state.tracks.clear();
  state.total = 0;
  clear(el("track-list"));
  clear(el("summary-body"));
  el("summary-panel").hidden = true;
  el("plan-panel").hidden = true;
  el("run-panel").hidden = false;
  el("progress-track").hidden = true;
  el("progress-count").textContent = "";

  setRunning(true);
  try {
    const result = await api("/api/check-matches", { method: "POST", body: "{}" });
    if (!result.started) throw new Error(result.error || "Could not start.");
  } catch (error) {
    setRunning(false);
    showSummary({ status: "error", message: error.message, failed: [] });
    return;
  }
  poll();
});
// Saved when it changes, not only when a sync starts. It reads as a setting
// rather than a per-run choice, so closing the window must not discard it.
el("opt-backup").addEventListener("change", async () => {
  const enabled = el("opt-backup").checked;
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ backupBeforeSync: enabled }),
    });
    if (!enabled) {
      note("Backups are off. Nothing will be saved to restore from.");
    }
  } catch (error) {
    note(error.message);
  }
});

el("btn-cancel").addEventListener("click", async () => {
  el("btn-cancel").disabled = true;
  await api("/api/cancel", { method: "POST" }).catch(() => {});
});

// The other half of Cancel. Stopping a sync leaves the database tidy but a
// freshly written one can still be in the operating system's write cache, and
// the moment after a sync is exactly when somebody in a hurry pulls the cable.
el("btn-eject").addEventListener("click", async () => {
  const button = el("btn-eject");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Ejecting…";
  try {
    const result = await api("/api/eject", { method: "POST", body: "{}" });
    if (result.ejected) {
      note(result.message || "Safe to unplug the iPod now.");
      button.textContent = "Safe to unplug";
      return;
    }
    note(result.error || "Could not eject the iPod.");
  } catch (error) {
    note(error.message);
  } finally {
    if (button.textContent === "Ejecting…") button.textContent = original;
    button.disabled = false;
  }
});

// Tells the application its window is still open.
//
// The alternative was waiting on the browser process, and that does not work:
// a Chromium launcher hands the request to a session process and exits, so the
// wait returns while the window is still on screen. 0.1.9 shut the server down
// at that point, which is why the window showed "can't reach this page".
//
// Five seconds, against a grace period several times longer on the other side,
// so a slow page load or a tab the system has throttled is never mistaken for a
// window that has been closed.
setInterval(() => {
  api("/api/ping").catch(() => {
    // The server has gone. Nothing to do: the window is about to be closed by
    // whoever stopped it, and retrying would only fill the console.
  });
}, 5000);

refreshState().then((data) => {
  // A sync started from the terminal, or a page reloaded mid-run, should pick
  // up where it is rather than showing an idle screen next to a busy engine.
  if (data && data.running) {
    setRunning(true);
    poll();
  }
});

import { createAuth0Client } from "@auth0/auth0-spa-js";
import "./engineering.js";
import {
  chords,
  compositionSchema,
  trackSchema,
  midiBytes,
  Player,
} from "./music.js";
import { createUniverse } from "./visualizer.js";
import { publicConfigSchema } from "./public-config.js";
import { composeNeural } from "./neural.js";
import { renderWav } from "./audio-export.js";
import { createShowcaseTrack, SHOWCASE_ID } from "./showcase.js";
import * as hostedAccount from "./hosted-account.js";
import * as firebaseAccount from "./firebase-account.js";
const { signInHref, signOutHref } = hostedAccount;
const accountMode = () => config.mode === "hosted" || config.mode === "firebase";
const accountApi = () => config.mode === "firebase" ? firebaseAccount : hostedAccount;
const readAccount = (...args) => accountApi().readAccount(...args);
const createAccount = (...args) => accountApi().createAccount(...args);
const listCloudTracks = (...args) => accountApi().listCloudTracks(...args);
const saveCloudTrack = (...args) => accountApi().saveCloudTrack(...args);
const removeCloudTrack = (...args) => accountApi().removeCloudTrack(...args);
const $ = (id) => document.getElementById(id),
  all = (s) => [...document.querySelectorAll(s)];
const player = new Player();
const universe = createUniverse($("universe"), () => player.spectrum());
let bars = 16,
  mood = "dream",
  shape = "orb",
  generating = false,
  paused = matchMedia("(prefers-reduced-motion: reduce)").matches,
  library = [],
  config = { mode: "loading" },
  ready = false,
  hostedSession = null,
  firebaseIdentity = null,
  sessionVersion = 0,
  libraryVersion = 0,
  privatePlayback = false,
  signingOut = false,
  auth = null,
  token = null,
  challengeId = null,
  toastTimer,
  interactionTimer;
const moodData = {
  dream: {
    chords: ["Am", "F", "C", "G"],
    tempo: 92,
    instrument: "piano",
    name: "Velvet reverie",
  },
  drift: {
    chords: ["C", "Am", "F", "G"],
    tempo: 66,
    instrument: "strings",
    name: "A slower kind of sky",
  },
  bloom: {
    chords: ["F", "C", "G", "Am"],
    tempo: 110,
    instrument: "piano",
    name: "Something like sunlight",
  },
  night: {
    chords: ["Dm", "Am", "Em", "Am"],
    tempo: 82,
    instrument: "synth",
    name: "When the city sleeps",
  },
};
let current = createShowcaseTrack();
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("visible"), 4500);
}
function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
function setShape(value) {
  shape = value;
  universe.setShape(value);
  all("[data-shape]").forEach((b) => {
    b.classList.toggle("selected", b.dataset.shape === value);
    b.setAttribute("aria-pressed", String(b.dataset.shape === value));
  });
  const copy = {
    orb: [
      "A MOMENT OF POSSIBILITY",
      "Everything starts with a spark.",
      "Shape your sound. See where it takes you.",
    ],
    galaxy: [
      "IDEAS IN ORBIT",
      generating
        ? "A new world is taking shape."
        : "Let your imagination wander.",
      "A constellation of notes, waiting to be heard.",
    ],
    brain: [
      "A THOUGHT BECOMES A MELODY",
      "A little intention. A new direction.",
      "Every choice leaves a trace in the sound.",
    ],
  }[value];
  $("state-eyebrow").textContent = copy[0];
  $("state-title").textContent = copy[1];
  $("state-copy").textContent = copy[2];
}
all("[data-shape]").forEach((b) =>
  b.addEventListener("click", () => setShape(b.dataset.shape)),
);
$("compose-form").addEventListener("focusin", (e) => {
  if (!generating && e.target.id !== "generate") {
    clearTimeout(interactionTimer);
    setShape("brain");
  }
});
$("compose-form").addEventListener("focusout", () => {
  if (!generating) interactionTimer = setTimeout(() => setShape("orb"), 2500);
});
function updateMotion() {
  universe.setPaused(paused);
  $("motion-toggle").textContent = paused ? "▷" : "Ⅱ";
  $("motion-toggle").setAttribute(
    "aria-label",
    paused ? "Resume visual motion" : "Pause visual motion",
  );
}
updateMotion();
$("motion-toggle").onclick = () => {
  paused = !paused;
  updateMotion();
};
for (let i = 0; i < 4; i++) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", `Seed chord ${i + 1}`);
  for (const chord of Object.keys(chords)) {
    const option = document.createElement("option");
    option.value = chord;
    option.textContent = chord;
    select.append(option);
  }
  select.value = moodData.dream.chords[i];
  $("chord-controls").append(select);
}
function selectMood(value) {
  mood = value;
  all("[data-mood]").forEach((b) => {
    b.classList.toggle("selected", b.dataset.mood === value);
    b.setAttribute("aria-pressed", String(b.dataset.mood === value));
  });
  const d = moodData[value];
  all("#chord-controls select").forEach((s, i) => (s.value = d.chords[i]));
  $("tempo").value = d.tempo;
  $("instrument").value = d.instrument;
}
all("[data-mood]").forEach(
  (b) => (b.onclick = () => selectMood(b.dataset.mood)),
);
all("[data-bars]").forEach(
  (b) =>
    (b.onclick = () => {
      bars = Number(b.dataset.bars);
      all("[data-bars]").forEach((x) => {
        x.classList.toggle("selected", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
    }),
);
$("temperature").oninput = () => {
  $("temperature-value").value = Number($("temperature").value).toFixed(2);
};
$("tempo-minus").onclick = () => {
  $("tempo").value = Math.max(50, Number($("tempo").value) - 2);
};
$("tempo-plus").onclick = () => {
  $("tempo").value = Math.min(180, Number($("tempo").value) + 2);
};
$("reset").onclick = () => {
  if (generating || !ready) return;
  selectMood("dream");
  $("temperature").value = 0.85;
  $("temperature-value").value = "0.85";
  all("[data-bars]")[0].click();
  setShape("orb");
  toast("A fresh start. Follow your curiosity.");
};
function localLibrary() {
  return config.mode === "demo" || (accountMode() && hostedSession !== null && !hostedSession.hasAccount);
}
function showMessage(id, message = "") {
  $(id).textContent = message;
  $(id).hidden = !message;
}
function persist() {
  if (!localLibrary()) return;
  try {
    localStorage.setItem(
      "auralis-demo-tracks",
      JSON.stringify(library.slice(0, 25)),
    );
  } catch {
    toast("Browser storage is full. Download your MIDI to keep it.");
  }
}
function loadLocal() {
  try {
    library = JSON.parse(localStorage.getItem("auralis-demo-tracks") || "[]")
      .slice(0, 25)
      .map((t) => trackSchema.parse(t));
  } catch {
    library = [];
  }
  renderLibrary();
}
async function api(path, options = {}) {
  if (!auth || !(await auth.isAuthenticated()))
    throw new Error("Sign in to use your cloud studio.");
  const access = await auth.getTokenSilently();
  const response = await fetch(config.apiBaseUrl + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${access}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    if (response.status === 429)
      throw new Error(
        "Your studio is busy. Please wait a minute and try again.",
      );
    if (response.status === 503)
      throw new Error(
        "The model service is not ready. Please try again later.",
      );
    if (response.status === 401 || response.status === 403)
      throw new Error(
        "Your session or bot check needs refreshing. Sign in and try again.",
      );
    throw new Error(`The request could not be completed (${response.status}).`);
  }
  return response;
}
async function refreshLibrary() {
  if (localLibrary()) return loadLocal();
  if (accountMode() && !hostedSession?.hasAccount) return;
  const version = ++libraryVersion;
  showMessage("library-state", "Loading your private library…");
  try {
    let tracks;
    if (accountMode()) {
      tracks = await listCloudTracks();
    } else {
      const response = await api("/v1/tracks?limit=50");
      tracks = (await response.json()).tracks.map((t) => trackSchema.parse(t));
    }
    if (version !== libraryVersion) return;
    library = tracks;
    showMessage("library-state");
    renderLibrary();
  } catch (error) {
    if (version !== libraryVersion) return;
    library = [];
    renderLibrary();
    showMessage("library-state", "Your private library could not be loaded. Open My compositions to retry.");
    throw error;
  }
}
function activate(track, isPrivate = false) {
  player.stop();
  current = track;
  privatePlayback = isPrivate;
  showMessage("save-warning");
  $("play").textContent = "▶";
  $("play").setAttribute("aria-label", "Play composition");
  $("track-title").textContent = track.title;
  $("track-eyebrow").textContent =
    track.id === SHOWCASE_ID
      ? "FEATURED MODEL OUTPUT"
      : track.model === "procedural-browser-demo"
        ? "PROCEDURAL SKETCH"
        : "NEURAL COMPOSITION";
  updateAuditionLabel();
  $("waveform").setAttribute(
    "aria-label",
    `Note timeline: ${track.notes.length} notes across ${track.bars} bars, shown by pitch and duration.`,
  );
  $("track-meta").textContent =
    `${{ piano: "Soft piano", synth: "Analog synth", strings: "Warm strings" }[track.instrument]} · ${track.tempo} BPM · ${track.bars} bars`;
  $("duration").textContent = formatTime(track.duration);
  drawWave();
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function downloadTrack(track) {
  try {
    const blob =
      config.mode !== "production" || track.id === SHOWCASE_ID
        ? new Blob([midiBytes(track)], { type: "audio/midi" })
        : await (
            await api(`/v1/tracks/${encodeURIComponent(track.id)}/midi`)
          ).blob();
    downloadBlob(
      blob,
      `${track.title.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 60)}.mid`,
    );
    toast("Your MIDI is ready for its next chapter.");
  } catch (e) {
    toast(e.message);
  }
}
$("download").onclick = () => downloadTrack(current);
$("download-audio").onclick = async () => {
  const button = $("download-audio"),
    track = current;
  button.disabled = true;
  try {
    const blob = await renderWav(track);
    downloadBlob(
      blob,
      `${track.title.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 60)}.wav`,
    );
    toast("Your audio is ready to keep.");
  } catch {
    toast(
      "This browser could not render the audio file. You can still export MIDI.",
    );
  } finally {
    button.disabled = false;
  }
};
function updateAuditionLabel() {
  const listening = player.playing && current.id === SHOWCASE_ID;
  $("audition-sample").textContent = listening
    ? "Ⅱ Pause example"
    : "▶ Hear the model · 0:40";
  $("audition-sample").setAttribute("aria-pressed", String(listening));
}
async function togglePlayback() {
  try {
    if (player.playing) {
      player.stop(false);
      $("play").textContent = "▶";
      $("play").setAttribute("aria-label", "Play composition");
    } else {
      await player.play(current);
      $("play").textContent = "Ⅱ";
      $("play").setAttribute("aria-label", "Pause composition");
    }
  } catch {
    toast("Audio could not start. Try pressing play again.");
  } finally {
    updateAuditionLabel();
  }
}
$("play").onclick = togglePlayback;
$("audition-sample").onclick = () => {
  if (current.id !== SHOWCASE_ID) activate(createShowcaseTrack());
  return togglePlayback();
};
player.onEnd = () => {
  $("play").textContent = "▶";
  $("play").setAttribute("aria-label", "Play composition");
  updateAuditionLabel();
};
$("volume").oninput = () => player.setVolume(Number($("volume").value));
$("volume-toggle").onclick = () => {
  const muted = player.volume > 0;
  player.setVolume(muted ? 0 : 0.65);
  $("volume").value = player.volume;
  $("volume-toggle").textContent = muted ? "×" : "♪";
  $("volume-toggle").setAttribute(
    "aria-label",
    muted ? "Unmute audio" : "Mute audio",
  );
};
function drawWave() {
  const canvas = $("waveform"),
    r = canvas.getBoundingClientRect();
  if (!r.width) return;
  const width = Math.max(1, Math.round(r.width * devicePixelRatio));
  const height = Math.round(40 * devicePixelRatio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, r.width, 40);
  ctx.fillStyle = "#30433a";
  for (let bar = 0; bar < current.bars; bar += 4) {
    ctx.fillRect((bar / current.bars) * r.width, 0, 1, 40);
  }
  const pitches = current.notes.map((note) => note.pitch);
  const low = Math.min(...pitches),
    high = Math.max(...pitches);
  const scale = r.width / current.duration,
    position = player.position();
  for (const note of current.notes) {
    ctx.fillStyle = note.start <= position ? "#c6f4d9" : "#a096b6";
    const y = 36 - ((note.pitch - low) / Math.max(1, high - low)) * 33;
    ctx.fillRect(note.start * scale, y, Math.max(1, note.duration * scale), 2);
  }
  if (position > 0) {
    ctx.fillStyle = "#d2f5df";
    ctx.fillRect(position * scale, 0, 1, 40);
  }
}
new ResizeObserver(drawWave).observe($("waveform"));
let lastWave = 0;
function tick(ms) {
  if (ms - lastWave > 90) {
    const position = player.position();
    $("elapsed").textContent = formatTime(position);
    $("progress-fill").style.width =
      `${Math.min(100, (position / current.duration) * 100)}%`;
    drawWave();
    lastWave = ms;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
function renderLibrary() {
  $("library-count").textContent = library.length;
  $("library-list").replaceChildren();
  if (!library.length) {
    const div = document.createElement("div");
    div.className = "empty-library";
    const h = document.createElement("h2");
    h.textContent = "A quiet place for your next idea.";
    const p = document.createElement("p");
    p.textContent = "Create a composition and it will find a home here.";
    const b = document.createElement("button");
    b.textContent = "Find your first sound ↗";
    b.onclick = () => showTab("studio");
    div.append(h, p, b);
    $("library-list").append(div);
    return;
  }
  for (const track of library) {
    const card = document.createElement("article");
    card.className = "library-card";
    const info = document.createElement("div"),
      title = document.createElement("h3"),
      meta = document.createElement("p");
    title.textContent = track.title;
    meta.textContent = `${track.bars} bars · ${track.tempo} BPM · ${formatTime(track.duration)} · ${new Date(track.created_at).toLocaleDateString()}`;
    info.append(title, meta);
    const play = document.createElement("button");
    play.textContent = "Open ↗";
    play.onclick = () => {
      activate(track, accountMode() && hostedSession?.hasAccount);
      showTab("studio");
    };
    const down = document.createElement("button");
    down.textContent = "↓ MIDI";
    down.onclick = () => downloadTrack(track);
    const del = document.createElement("button");
    del.textContent = "×";
    del.setAttribute("aria-label", `Delete ${track.title}`);
    del.onclick = async () => {
      if (
        !confirm(
          `Delete “${track.title}” from your ${localLibrary() ? "browser" : "account"} library?`,
        )
      )
        return;
      const version = sessionVersion;
      del.disabled = true;
      try {
        if (accountMode() && hostedSession?.hasAccount)
          await removeCloudTrack(track.id);
        else if (config.mode === "production")
          await api(`/v1/tracks/${encodeURIComponent(track.id)}`, {
            method: "DELETE",
          });
        if (version !== sessionVersion) return;
        ++libraryVersion;
        library = library.filter((t) => t.id !== track.id);
        persist();
        if (current.id === track.id) activate(createShowcaseTrack());
        renderLibrary();
        toast("Composition removed.");
      } catch (e) {
        toast(e.message);
      } finally {
        del.disabled = false;
      }
    };
    card.append(info, play, down, del);
    $("library-list").append(card);
  }
}
function showTab(tab) {
  $("studio-view").hidden = tab !== "studio";
  $("library-view").hidden = tab !== "library";
  all(".nav[data-tab]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab),
  );
  if (tab === "library" && ready && config.mode !== "demo")
    refreshLibrary().catch((e) => toast(e.message));
  if (tab === "studio") requestAnimationFrame(drawWave);
}
all("[data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
$("compose-form").onsubmit = async (e) => {
  e.preventDefault();
  if (generating || !ready) return;
  let params;
  try {
    params = compositionSchema.parse({
      seed_chords: all("#chord-controls select").map((s) => s.value),
      temperature: Number($("temperature").value),
      bars,
      tempo: Number($("tempo").value),
      instrument: $("instrument").value,
    });
  } catch {
    toast("Choose a tempo from 50 to 180 and check your settings.");
    return;
  }
  generating = true;
  try {
    if (config.mode === "production" && (!auth || !(await auth.isAuthenticated()))) {
      generating = false;
      $("account-dialog").showModal();
      return;
    }
    if (config.mode === "production" && !token) {
      generating = false;
      toast("Complete the bot verification before composing.");
      return;
    }
  } catch {
    generating = false;
    toast("Your session could not be verified. Please sign in again.");
    return;
  }
  clearTimeout(interactionTimer);
  player.stop();
  updateAuditionLabel();
  $("play").textContent = "▶";
  $("play").setAttribute("aria-label", "Play composition");
  $("generate").disabled = true;
  all("#compose-form input,#compose-form select,#compose-form button").forEach(
    (x) => (x.disabled = true),
  );
  $("generate-label").textContent = "Gathering your notes…";
  setShape("galaxy");
  const version = sessionVersion;
  try {
    let track;
    if (config.mode !== "production") {
      track = trackSchema.parse(await composeNeural(params));
      if (version !== sessionVersion) return;
      track.title = moodData[mood].name;
      if (accountMode() && !localLibrary()) {
        // Keep the playable score if the quota, session or network rejects the save.
        activate(track, true);
        try {
          if (!hostedSession?.hasAccount) throw new Error("Reconnect your account to save to your library.");
          track = await saveCloudTrack(track);
        } catch (error) {
          if (version === sessionVersion)
            showMessage("save-warning", `This composition is ready to play, but its cloud save was not confirmed. ${error.message} Download MIDI or WAV to keep a copy.`);
          return;
        }
      }
    } else {
      const response = await api("/v1/tracks", {
        method: "POST",
        body: JSON.stringify({
          ...params,
          title: moodData[mood].name,
          turnstile_token: token,
        }),
      });
      track = trackSchema.parse(await response.json());
    }
    if (version !== sessionVersion) return;
    ++libraryVersion;
    library = [track, ...library.filter((t) => t.id !== track.id)].slice(0, localLibrary() ? 25 : 50);
    persist();
    renderLibrary();
    activate(track, accountMode() && hostedSession?.hasAccount);
    showMessage("library-state");
    toast(hostedSession?.hasAccount ? "Saved to your private library." : "A new composition, entirely yours to explore.");
    $("state-title").textContent = "You made a little wonder.";
    $("state-copy").textContent = "Press play. Let the light follow the music.";
  } catch (e) {
    toast(
      e.message || "Something interrupted the composition. Please try again.",
    );
  } finally {
    generating = false;
    all(
      "#compose-form input,#compose-form select,#compose-form button",
    ).forEach((x) => (x.disabled = false));
    $("generate").disabled = !ready || signingOut;
    $("generate-label").textContent = "Create a composition";
    if (
      config.mode === "production" &&
      globalThis.turnstile &&
      challengeId !== null
    ) {
      token = null;
      turnstile.reset(challengeId);
    }
    setTimeout(() => {
      if (!generating) setShape("orb");
    }, 2000);
  }
};
$("about-open").onclick = () => $("about-dialog").showModal();
$("model-notes").onclick = () => $("about-dialog").showModal();
$("account").onclick = () => $("account-dialog").showModal();
all(".dialog-close").forEach(
  (b) => (b.onclick = () => b.closest("dialog").close()),
);
all("dialog").forEach((d) =>
  d.addEventListener("click", (e) => {
    if (e.target === d) {
      const r = d.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        d.close();
    }
  }),
);

let emailSignup = false;
let accountBusy = false;
function renderFirebaseAccount() {
  const identity = hostedSession || firebaseIdentity;
  const signedIn = Boolean(identity?.authenticated);
  const verified = Boolean(identity?.emailVerified);
  const hasProfile = Boolean(hostedSession?.hasAccount);
  $("account").classList.add("hosted-account");
  $("account").textContent = signedIn ? "My account" : "Sign in / Create account";
  $("account").setAttribute("aria-label", $("account").textContent);
  $("account").setAttribute("aria-haspopup", "dialog");
  $("hosted-signin").hidden = true;
  $("hosted-signout").hidden = true;
  $("firebase-account").hidden = false;
  $("firebase-signed-out").hidden = signedIn || !hostedSession;
  $("firebase-verification").hidden = !signedIn || verified;
  $("firebase-signout").hidden = !signedIn;
  $("auth-action").hidden = true;
  $("mode-label").textContent = hasProfile ? "Private library" : "Guest studio";
  $("account-title").textContent = signedIn ? "Your Auralis account" : "Take your music with you";
  $("account-description").textContent = signedIn
    ? `Signed in as ${identity.email || identity.displayName || "Composer"}. ${verified ? "" : "Check your inbox and verify your email to unlock your private cloud library."}`
    : "Sign in with Google or email to keep a private music library across devices. You can also compose as a guest.";
  $("account-notice").textContent = hasProfile
    ? "Your library holds 50 compositions. Sign-in lasts for this browser tab. Signing out clears private music from the studio."
    : "Guest music stays on this device. Creating a private library saves future compositions to your account; earlier guest music stays local.";
  $("library-description").textContent = hasProfile
    ? "Your private compositions, available wherever you sign in."
    : "Guest compositions saved in this browser profile.";
  $("demo-note").textContent = hasProfile
    ? "Generated on this device · Saved to your account"
    : "Guest studio · Saved in this browser";
  if (signedIn && verified && !hasProfile) {
    $("auth-action").hidden = false;
    $("auth-action").textContent = "Create my private library ↗";
    $("auth-action").onclick = registerHostedAccount;
  }
  if (!hostedSession) {
    $("mode-label").textContent = "Account offline";
    $("account-description").textContent = "Your account connection could not be checked. Reconnect to open your library.";
    $("demo-note").textContent = "Account offline · Download to keep your track";
    $("auth-action").hidden = false;
    $("auth-action").textContent = "Check connection";
    $("auth-action").onclick = () => syncHostedAccount();
  }
}
function updateEmailMode() {
  $("email-submit").textContent = emailSignup ? "Create account with email ↗" : "Sign in with email ↗";
  $("email-mode").textContent = emailSignup ? "Already have an account? Sign in" : "Create an account";
  $("account-password").autocomplete = emailSignup ? "new-password" : "current-password";
  $("account-password").minLength = emailSignup ? 12 : 6;
  $("account-password").placeholder = emailSignup ? "At least 12 characters" : "Your password";
}
async function accountAction(action, success = "") {
  if (accountBusy) return;
  if (generating && action !== firebaseAccount.signOut) { toast("Finish the current composition first."); return; }
  accountBusy = true;
  all("#firebase-account button").forEach((button) => button.disabled = true);
  showMessage("account-status", "Connecting…");
  try {
    const result = await action();
    showMessage("account-status", typeof result === "string" ? result : success);
  } catch (error) {
    showMessage("account-status", error.message || "Please try again.");
  } finally {
    $("account-password").value = "";
    accountBusy = false;
    all("#firebase-account button").forEach((button) => button.disabled = false);
  }
}
$("email-mode").onclick = () => { emailSignup = !emailSignup; updateEmailMode(); showMessage("account-status"); };
$("email-account-form").onsubmit = (event) => {
  event.preventDefault();
  const method = emailSignup ? firebaseAccount.signUpEmail : firebaseAccount.signInEmail;
  return accountAction(() => method($("account-email").value, $("account-password").value),
    emailSignup ? "Check your inbox for a verification email." : "Signed in.");
};
$("google-signin").onclick = () => accountAction(firebaseAccount.signInGoogle);
$("firebase-signout").onclick = () => accountAction(firebaseAccount.signOut, "Signed out. Your guest library is on this device.");
$("email-reset").onclick = () => {
  if (!$("account-email").reportValidity()) return;
  return accountAction(() => firebaseAccount.sendReset($("account-email").value));
};
$("verify-resend").onclick = () => accountAction(firebaseAccount.resendVerification, "Check your inbox for the verification link.");
$("verify-refresh").onclick = () => accountAction(async () => {
  const state = await firebaseAccount.refreshVerification();
  return state.emailVerified ? "Email verified. You can now create your private library." : "Your email is not verified yet. Open the link in your inbox, then try again.";
});

function renderHostedAccount() {
  if (config.mode === "firebase") return renderFirebaseAccount();
  const signedIn = Boolean(hostedSession?.authenticated);
  const hasProfile = Boolean(hostedSession?.hasAccount);
  const header = $("account");
  header.classList.add("hosted-account");
  header.textContent = hasProfile ? "My account" : signedIn ? "Create account" : "Sign in / Create account";
  header.setAttribute("aria-label", header.textContent);
  header.setAttribute("aria-haspopup", "dialog");
  $("mode-label").textContent = hasProfile ? "Private library" : "Guest studio";
  $("hosted-signin").href = signInHref;
  $("hosted-signin").hidden = signedIn || !hostedSession;
  $("hosted-signout").href = signOutHref;
  $("hosted-signout").hidden = !signedIn;
  $("auth-action").hidden = true;
  if (!hostedSession) {
    header.textContent = "Account";
    header.setAttribute("aria-label", "Account connection");
    $("mode-label").textContent = "Account offline";
    $("account-title").textContent = "Reconnect your library";
    $("account-description").textContent = "Account status could not be checked. You can compose and download music while reconnecting.";
    $("account-notice").textContent = "New tracks stay in the player until a save is confirmed.";
    $("library-description").textContent = "Reconnect to see your library.";
    $("auth-action").hidden = false;
    $("auth-action").textContent = "Check connection";
    $("auth-action").onclick = () => syncHostedAccount();
  } else if (hasProfile) {
    $("account-title").textContent = "Your Auralis account";
    $("account-description").textContent = hostedSession.displayName
      ? `Signed in as ${hostedSession.displayName}.`
      : "You’re signed in with ChatGPT.";
    $("account-notice").textContent = "Save up to 50 compositions. Sign in with this ChatGPT account on another device to open them. You can download or delete each track in My compositions.";
    $("library-description").textContent = "Your private compositions, available on every device where you sign in.";
  } else if (signedIn) {
    $("account-title").textContent = "Create your Auralis account";
    $("account-description").textContent = "Your ChatGPT sign-in is ready. Create a profile to save new compositions and open them on any device.";
    $("account-notice").textContent = "Your library holds up to 50 compositions. Earlier guest compositions stay in this browser profile and are not uploaded.";
    $("library-description").textContent = "Guest compositions on this device. Create an account to save new music across devices.";
    $("auth-action").hidden = false;
    $("auth-action").textContent = "Create my account";
    $("auth-action").onclick = registerHostedAccount;
  } else {
    $("account-title").textContent = "Take your music with you";
    $("account-description").textContent = "Sign in with ChatGPT to open your private library or create an Auralis account. You can also keep composing as a guest.";
    $("account-notice").textContent = "Guest compositions stay in this browser profile. After you create an account, new tracks are saved to your private library.";
    $("library-description").textContent = "Your guest compositions are saved on this device. Sign in or create an account to save new tracks across devices.";
  }
  $("demo-note").textContent = !hostedSession ? "Account offline · Download to keep your track"
    : hasProfile ? "Generated on this device · Saved to your account"
    : "Guest studio · Saved in this browser";
}

function clearPrivateView() {
  ++sessionVersion;
  ++libraryVersion;
  library = [];
  renderLibrary();
  if (privatePlayback) activate(createShowcaseTrack());
  hostedSession = null;
  showMessage("account-status");
  showMessage("library-state");
}

async function syncHostedAccount({ showSetup = false } = {}) {
  if (signingOut) return;
  clearPrivateView();
  const version = sessionVersion;
  ready = false;
  $("generate").disabled = true;
  $("auth-action").disabled = true;
  try {
    const state = await readAccount();
    if (version !== sessionVersion) return;
    hostedSession = state;
    renderHostedAccount();
    if (hostedSession.hasAccount) {
      await refreshLibrary();
    } else {
      loadLocal();
    }
    if (showSetup && state.authenticated && !state.hasAccount && !$("account-dialog").open)
      $("account-dialog").showModal();
  } catch (error) {
    if (version !== sessionVersion) return;
    renderHostedAccount();
    showMessage("account-status", error.message || "Could not check the account connection.");
    if (!hostedSession) showMessage("library-state", "Private tracks are unavailable. Open Account to reconnect.");
  } finally {
    if (version === sessionVersion && !signingOut) {
      ready = true;
      $("auth-action").disabled = false;
      $("generate").disabled = generating;
    }
  }
}

async function registerHostedAccount() {
  if (generating || signingOut) { toast("Finish the current operation first."); return; }
  const button = $("auth-action"), version = sessionVersion;
  button.disabled = true;
  ready = false;
  $("generate").disabled = true;
  showMessage("account-status", "Creating your account…");
  try {
    const state = await createAccount();
    if (version !== sessionVersion) return;
    if (!state.hasAccount) throw new Error("Account creation was not confirmed. Check your connection and try again.");
    ++libraryVersion;
    hostedSession = state;
    library = [];
    renderLibrary();
    renderHostedAccount();
    showMessage("account-status", "Your account is ready. Your next composition will be saved here.");
    await refreshLibrary();
    toast("Your private library is ready.");
  } catch (error) {
    if (version === sessionVersion)
      showMessage("account-status", error.message || "The account could not be created. Try again.");
  } finally {
    if (version === sessionVersion && !signingOut) {
      ready = true;
      button.disabled = false;
      $("generate").disabled = generating;
    }
  }
}

$("hosted-signout").addEventListener("click", () => {
  signingOut = true;
  ready = false;
  $("generate").disabled = true;
  clearPrivateView();
  renderHostedAccount();
  if ($("account-dialog").open) $("account-dialog").close();
});

document.addEventListener("visibilitychange", () => {
  if (config.mode !== "hosted" || signingOut) return;
  if (document.hidden) {
    ready = false;
    $("generate").disabled = true;
    clearPrivateView();
    renderHostedAccount();
  } else {
    syncHostedAccount();
  }
});

async function initialize() {
  try {
    const response = await fetch("/config.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to load studio configuration.");
    config = publicConfigSchema.parse(await response.json());
    if (config.mode === "firebase") {
      $("architecture-cloud").textContent = "Verified email or Google sign-in → Firebase Auth → Firestore security rules. Your user ID scopes every library read and write.";
      await firebaseAccount.initFirebaseAccount(config.firebase, (state) => {
        firebaseIdentity = state;
        return syncHostedAccount();
      });
      if (new URLSearchParams(location.search).get("account") === "setup") {
        if (!$("account-dialog").open) $("account-dialog").showModal();
        history.replaceState({}, "", location.pathname);
      }
      return;
    }
    if (config.mode === "hosted") {
      const params = new URLSearchParams(location.search);
      const showSetup = params.get("account") === "setup";
      await syncHostedAccount({ showSetup });
      if (showSetup) history.replaceState({}, "", location.pathname);
      return;
    }
    if (config.mode === "demo") {
      loadLocal();
      ready = true;
      $("generate").disabled = false;
      return;
    }
    if (
      config.mode !== "production" ||
      !/^https:\/\/[a-z0-9.-]+(?::443)?$/.test(config.apiBaseUrl) ||
      !/^[a-z0-9.-]+$/.test(config.auth0Domain) ||
      !config.auth0ClientId ||
      !config.auth0Audience ||
      !config.turnstileSiteKey
    )
      throw new Error("Production configuration is incomplete.");
    $("mode-label").textContent = "Cloud studio";
    $("demo-note").textContent =
      "Private to your account · Secure cloud inference";
    $("engine-note").textContent = "PyTorch LSTM engine";
    $("engine-location").textContent = "Cloud inference";
    $("model-explanation").textContent =
      "Your seed progression conditions a PyTorch LSTM on the server. Temperature controls the distribution of the next note. Each track is stored and retrieved inside your verified account.";
    $("account-notice").textContent =
      "Your cloud tracks are retrieved using a short-lived access token. The browser does not store a copy in its demo library.";
    $("library-description").textContent =
      "Compositions in your private cloud library.";
    $("account-title").textContent = "Your sound. Your space.";
    $("account-description").textContent =
      "Sign in to generate music and access your private composition library.";
    auth = await createAuth0Client({
      domain: config.auth0Domain,
      clientId: config.auth0ClientId,
      cacheLocation: "memory",
      useRefreshTokens: false,
      authorizationParams: {
        audience: config.auth0Audience,
        scope: "openid profile email tracks:read tracks:write",
        redirect_uri: location.origin,
      },
    });
    if (
      location.search.includes("code=") &&
      location.search.includes("state=")
    ) {
      await auth.handleRedirectCallback();
      history.replaceState({}, "", location.pathname);
    }
    const authenticated = await auth.isAuthenticated();
    $("auth-action").hidden = false;
    $("auth-action").textContent = authenticated
      ? "Sign out ↗"
      : "Sign in securely ↗";
    $("auth-action").onclick = async () => {
      if (!authenticated) return auth.loginWithRedirect();
      ready = false;
      token = null;
      library = [];
      player.stop();
      renderLibrary();
      current.notes = [];
      $("generate").disabled = true;
      $("play").disabled = true;
      await auth.logout({ logoutParams: { returnTo: location.origin } });
    };
    if (authenticated) {
      $("account-description").textContent =
        "You are signed in. Your cloud library is scoped to your verified identity.";
      await refreshLibrary();
      if (library.length) activate(library[0]);
    }
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.onload = () => {
      challengeId = turnstile.render("#turnstile", {
        sitekey: config.turnstileSiteKey,
        action: "generate",
        theme: "dark",
        callback: (t) => (token = t),
        "expired-callback": () => (token = null),
        "error-callback": () => {
          token = null;
          toast("Bot verification could not load. Please refresh.");
        },
      });
    };
    script.onerror = () =>
      toast("Bot verification is unavailable. Generation is disabled.");
    document.head.append(script);
    ready = true;
    $("generate").disabled = false;
  } catch (e) {
    config.mode = "unavailable";
    $("mode-label").textContent = "Connection unavailable";
    $("generate").disabled = true;
    $("generate-label").textContent = "Configuration required";
    toast(e.message);
  }
}
activate(current);
initialize();
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});
window.addEventListener("pagehide", () => {
  player.stop();
  universe.dispose();
});

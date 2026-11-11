// script.js  – module ES, donc chargé avec type="module" ----------------

// ---------------------------------------------------
// 1)  Firebase : ne sert plus qu'aux statistiques (Analytics)
// ---------------------------------------------------
const firebaseConfig = {
    apiKey: "AIzaSyABWMf5IYZbIQfMVrsz8TgitSg8D9dVTRs",
    authDomain: "lastlink-1a510.firebaseapp.com",
    projectId: "lastlink-1a510",
    storageBucket: "lastlink-1a510.firebasestorage.app",
    messagingSenderId: "842812784317",
    appId: "1:842812784317:web:a6304801223d04bec401d4",
    measurementId: "G-Q12TR5LHP2"
};

// Chargées à part : si un bloqueur de pub les refuse, le site marche quand même
Promise.all([
    import("https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/12.0.0/firebase-analytics.js")
])
    .then(([{ initializeApp }, { getAnalytics }]) => getAnalytics(initializeApp(firebaseConfig)))
    .catch(() => { });

// ---------------------------------------------------
// 2)  Serveur LastLink (homelab) : chansons + messages
// ---------------------------------------------------
// Le site est servi par le serveur LastLink lui-même : l'API est à la même adresse.
// Les copies du site sur GitHub Pages et Vercel appellent le homelab.
const API = /(^|\.)(github\.io|vercel\.app)$/.test(location.hostname) ? "https://lastlink.nanodev.app" : "";

async function api(path, body) {
    const res = await fetch(API + path, body && {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
}

// ---------------------------------------------------
// 3)  Helpers
// ---------------------------------------------------

// Les photos d'origine sont lourdes : on affiche leur miniature
// (même nom, en .webp, dans assets/covers/)
const thumbOf = cover => cover.replace("assets/photos/", "assets/covers/").replace(/\.png$/, ".webp");

// Retrouve le lien dans le texte collé (ajoute https:// si besoin)
// et refuse tout ce qui n'est pas un lien web (ex. "javascript:")
function parseUrl(text) {
    const raw = (text || "").trim();
    const value = raw.match(/https?:\/\/\S+/i)?.[0] ?? raw;
    if (!value) return null;
    try {
        const url = new URL(/^https?:\/\//i.test(value) ? value : "https://" + value);
        return url.hostname.includes(".") ? url : null;
    } catch {
        return null;
    }
}

// "aujourd’hui", "hier", "il y a 3 jours", puis "12 mars" (+ l'année si besoin)
const relative = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysAgo = date => Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
const sameYear = date => date.getFullYear() === new Date().getFullYear();

function formatDate(date) {
    const days = daysAgo(date);
    if (days < 7) return relative.format(-Math.max(days, 0), "day");
    return date.toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "long",
        year: sameYear(date) ? undefined : "numeric"
    });
}

// Heure des messages : "14:32", "hier, 14:32", "lundi, 14:32", puis "12 mars, 14:32"
const hourFormat = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

function formatTime(date) {
    const days = daysAgo(date);
    const hour = hourFormat.format(date);
    if (days <= 0) return hour;
    if (days === 1) return `hier, ${hour}`;
    const day = days < 7
        ? date.toLocaleDateString("fr-FR", { weekday: "long" })
        : date.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: sameYear(date) ? undefined : "numeric" });
    return `${day}, ${hour}`;
}

const byId = (parent, id) => parent.querySelector(`[data-id="${CSS.escape(id)}"]`);

// Copie de ce qui est affiché, gardée sur l'appareil : montrée si le serveur ne répond pas
const CACHE_KEY = "lastlink-cache";
const state = { songs: [], messages: [] };

function saveCache() {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(state));
    } catch { }
}

// ---------------------------------------------------
// 4)  Références DOM
// ---------------------------------------------------
const list = document.getElementById("song-list");
const songCount = document.getElementById("song-count");
const listStatus = document.getElementById("list-status");
const form = document.getElementById("song-form");
const urlInput = document.getElementById("song-url");
const nameInput = document.getElementById("song-name");
const sharerField = form.querySelector("fieldset");
const submitBtn = document.getElementById("add-song-btn");
const formStatus = document.getElementById("form-status");

const chat = document.getElementById("chat");
const chatList = document.getElementById("chat-list");
const chatStatus = document.getElementById("chat-status");
const chatForm = document.getElementById("chat-form");
const chatSender = chatForm.querySelector("fieldset");
const chatText = document.getElementById("chat-text");
const chatSend = document.getElementById("chat-send");
const chatError = document.getElementById("chat-error");

// ---------------------------------------------------
// 5)  Rendu des chansons
// ---------------------------------------------------
function createSong(s, isNew) {
    const li = document.createElement("li");
    li.className = isNew ? "song is-new" : "song";
    li.dataset.id = s.id;
    li.innerHTML = `
    <a class="song-link" target="_blank" rel="noopener noreferrer">
      <img class="song-cover" width="64" height="64" alt="" loading="lazy" decoding="async">
      <span class="song-text">
        <span class="song-title"></span>
        <span class="song-meta">
          <span class="song-sharer"></span>
          <time class="song-date"></time>
        </span>
      </span>
      <svg class="song-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>
    </a>
  `;

    // Miniature, ou photo d'origine si la miniature n'existe pas
    const img = li.querySelector("img");
    const cover = s.cover || "assets/photos/image.png";
    img.onerror = () => {
        img.onerror = null;
        img.src = cover;
    };
    img.src = thumbOf(cover);

    // Textes (via textContent : un titre ne peut pas injecter de HTML)
    const link = li.querySelector(".song-link");
    const url = parseUrl(s.url);
    if (url) link.href = url.href;
    else link.removeAttribute("href");

    li.querySelector(".song-title").textContent = s.name;

    const sharer = li.querySelector(".song-sharer");
    sharer.textContent = s.sharedBy ?? "";
    sharer.dataset.sharer = s.sharedBy ?? "";

    const date = new Date(s.createdAt);
    const time = li.querySelector(".song-date");
    if (!Number.isNaN(date.getTime())) {
        time.textContent = formatDate(date);
        time.dateTime = date.toISOString();
    }
    return li;
}

function renderSongs(songs) {
    state.songs = songs;
    list.replaceChildren(...songs.map(s => createSong(s, false)));
    list.setAttribute("aria-busy", "false");
    showSongCount();
}

// Chanson reçue en direct ou ajoutée depuis cette page (jamais en double)
function addSong(s) {
    if (byId(list, s.id)) return;
    list.prepend(createSong(s, true));
    showSongCount();
    state.songs.unshift(s);
    saveCache();
}

function showSongCount() {
    const n = list.children.length;
    songCount.textContent = n || "";
    listStatus.classList.remove("is-error");
    listStatus.textContent = "Pas encore de chanson. Ajoute la première !";
    listStatus.hidden = n > 0;
}

// ---------------------------------------------------
// 6)  Rendu des messages
// ---------------------------------------------------
function createMessage(m) {
    const li = document.createElement("li");
    li.className = "msg";
    li.dataset.id = m.id;
    li.dataset.from = m.sentBy;
    li.innerHTML = `<p class="msg-text"></p><p class="msg-meta"><span class="msg-from"></span><time class="msg-time"></time></p>`;
    li.querySelector(".msg-text").textContent = m.text;
    li.querySelector(".msg-from").textContent = m.sentBy;

    const date = new Date(m.createdAt);
    const time = li.querySelector("time");
    time.textContent = formatTime(date);
    time.dateTime = date.toISOString();
    return li;
}

// Plusieurs messages d'affilée de la même personne : son prénom une seule fois
function markFollowUp(li) {
    const prev = li.previousElementSibling;
    const gap = prev && new Date(li.querySelector("time").dateTime) - new Date(prev.querySelector("time").dateTime);
    li.classList.toggle("is-follow-up", !!prev && prev.dataset.from === li.dataset.from && gap < 10 * 60000);
}

const nearBottom = () => chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 80;
const toBottom = () => {
    chatList.scrollTop = chatList.scrollHeight;
};

function renderMessages(messages) {
    state.messages = messages;
    chatList.replaceChildren(...messages.map(createMessage));
    for (const li of chatList.children) markFollowUp(li);
    chatList.setAttribute("aria-busy", "false");
    showChatEmpty();
    toBottom();
}

function addMessage(m) {
    if (byId(chatList, m.id)) return;
    const follow = nearBottom() || m.sentBy === me;  // on ne tire pas la liste sous les yeux de quelqu'un qui relit
    const li = createMessage(m);
    li.classList.add("is-new");
    chatList.append(li);
    markFollowUp(li);
    showChatEmpty();
    if (follow) toBottom();
    state.messages = [...state.messages, m].slice(-300);    // le serveur en renvoie 300 au plus
    saveCache();
}

function showChatEmpty() {
    chatStatus.classList.remove("is-error");
    chatStatus.textContent = "Pas encore de message. Écris le premier !";
    chatStatus.hidden = chatList.children.length > 0;
}

// ---------------------------------------------------
// 7)  Chargement, copie hors ligne et direct
// ---------------------------------------------------
let shown = false;                              // quelque chose est affiché (copie ou serveur)
let syncing = false;
const queued = [];

// Ce qui arrive en direct pendant un chargement est appliqué juste après
function apply(type, item) {
    if (syncing) return queued.push([type, item]);
    if (type === "song") addSong(item);
    else addMessage(item);
}

async function sync() {
    syncing = true;
    try {
        const [{ songs }, { messages }] = await Promise.all([api("/api/songs"), api("/api/messages")]);
        renderSongs(songs);
        renderMessages(messages);
        shown = true;
        saveCache();
    } catch (err) {
        console.error(err);
        showOffline();
    } finally {
        syncing = false;
        for (const [type, item] of queued.splice(0)) apply(type, item);
    }
}

// Serveur injoignable : on garde la dernière liste vue sur l'appareil, sinon on le dit
function showOffline() {
    if (shown) {
        listStatus.textContent = chatStatus.textContent = "Serveur injoignable pour l’instant : affichage de ta dernière visite.";
        listStatus.hidden = chatStatus.hidden = false;
        return;
    }
    list.replaceChildren();
    list.setAttribute("aria-busy", "false");
    chatList.setAttribute("aria-busy", "false");
    listStatus.textContent = "Impossible de charger les chansons pour l’instant. Réessaie dans un moment.";
    chatStatus.textContent = "Impossible de charger les messages pour l’instant.";
    for (const status of [listStatus, chatStatus]) {
        status.classList.add("is-error");
        status.hidden = false;
    }
}

let interrupted = false;

function connect() {
    const live = new EventSource(API + "/api/events");
    live.addEventListener("song", e => apply("song", JSON.parse(e.data)));
    live.addEventListener("message", e => apply("message", JSON.parse(e.data)));
    // Connexion revenue (réseau, téléphone en veille…) : on rattrape ce qui a été manqué
    live.addEventListener("open", () => {
        if (interrupted) sync();
        interrupted = false;
    });
    live.addEventListener("error", () => {
        interrupted = true;
        // Le navigateur abandonne si le serveur répond une erreur (homelab éteint…) : on relance nous-mêmes
        if (live.readyState === EventSource.CLOSED) setTimeout(connect, 15000);
    });
}

// ---------------------------------------------------
// 8)  Valentin ou Iman ? (mémorisé sur l'appareil, pour les chansons et le chat)
// ---------------------------------------------------
const SHARER_KEY = "lastlink-sharer";
let me = "";

function setMe(person, remember = true) {
    me = person;
    for (const radio of [...form.elements.sharer, ...chatForm.elements.sender]) radio.checked = radio.value === person;
    chat.dataset.me = person;                   // ses propres messages passent à droite
    if (!remember) return;
    try {
        localStorage.setItem(SHARER_KEY, person);
    } catch { }
}

try {
    const saved = localStorage.getItem(SHARER_KEY);
    if (saved === "Valentin" || saved === "Iman") setMe(saved, false);
} catch {
    // stockage indisponible (navigation privée…) : on choisit à chaque fois
}

sharerField.addEventListener("change", e => {
    showError(sharerField, "");
    setMe(e.target.value);
});

chatSender.addEventListener("change", e => {
    chatError.textContent = "";
    setMe(e.target.value);
});

// ---------------------------------------------------
// 9)  Titre rempli tout seul (Spotify, YouTube, SoundCloud)
// ---------------------------------------------------
function oembedFor(url) {
    const host = url.hostname.replace(/^(www|m)\./, "");
    if (host === "open.spotify.com") return "https://open.spotify.com/oembed?url=";
    if (host === "soundcloud.com") return "https://soundcloud.com/oembed?format=json&url=";
    if (host === "youtube.com" || host === "music.youtube.com" || host === "youtu.be") {
        return "https://www.youtube.com/oembed?format=json&url=";
    }
    return null;
}

// Enlève "(Official Video)", "[Clip officiel]", "(Lyrics)"… des titres YouTube
const tidyTitle = title => title
    .replace(/\s*[([][^)\]]*\b(official|officiel|clip|lyrics?|paroles|audio|vid[eé]o|visuali[sz]er|4k|hd)\b[^)\]]*[)\]]/gi, "")
    .trim();

const namePlaceholder = nameInput.placeholder;
const isAutoTitle = () => nameInput.dataset.auto && nameInput.value === nameInput.dataset.auto;
const canFillTitle = () => !nameInput.value.trim() || isAutoTitle();   // jamais un titre tapé à la main
let lookupId = 0;
let lookupTimer;

async function fillTitle() {
    const id = lookupId;
    const url = parseUrl(urlInput.value);
    const endpoint = url && oembedFor(url);
    if (!canFillTitle()) return;
    if (!endpoint) {
        if (isAutoTitle()) nameInput.value = "";  // le titre venait de l'ancien lien
        return;
    }

    nameInput.placeholder = "Recherche du titre…";
    try {
        const res = await fetch(endpoint + encodeURIComponent(url.href));
        const { title } = await res.json();
        if (id === lookupId && title && canFillTitle()) {
            nameInput.value = nameInput.dataset.auto = tidyTitle(title);
            showError(nameInput, "");
        }
    } catch {
        // pas grave : le titre se tape à la main
    } finally {
        if (id === lookupId) nameInput.placeholder = namePlaceholder;
    }
}

urlInput.addEventListener("input", () => {
    showError(urlInput, "");
    setStatus("");
    lookupId++;                                 // annule une recherche en cours
    nameInput.placeholder = namePlaceholder;
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(fillTitle, 300);
});

nameInput.addEventListener("input", () => {
    showError(nameInput, "");
    setStatus("");
});

// ---------------------------------------------------
// 10)  Messages d'erreur / de confirmation
// ---------------------------------------------------
function showError(field, message) {
    const error = field.closest(".field").querySelector(".field-error");
    error.textContent = message;
    error.hidden = !message;
    if (field === sharerField) return;
    if (message) field.setAttribute("aria-invalid", "true");
    else field.removeAttribute("aria-invalid");
}

function setStatus(message, isError = false) {
    formStatus.textContent = message;
    formStatus.classList.toggle("is-error", isError);
}

// ---------------------------------------------------
// 11)  Ajout d'une chanson
// ---------------------------------------------------
form.onsubmit = async e => {
    e.preventDefault();
    setStatus("");

    const url = parseUrl(urlInput.value);
    const name = nameInput.value.trim();
    const sharedBy = form.elements.sharer.value;

    showError(urlInput, url ? "" : urlInput.value.trim() ? "Ce lien n’a pas l’air valide." : "Colle le lien de la chanson.");
    showError(nameInput, name ? "" : "Donne un titre à la chanson.");
    showError(sharerField, sharedBy ? "" : "Choisis qui partage la chanson.");
    const invalid = !url ? urlInput : !name ? nameInput : !sharedBy ? form.elements.sharer[0] : null;
    if (invalid) {
        invalid.focus();
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Ajout…";
    try {
        // la photo est choisie par le serveur (la moins utilisée)
        const { song } = await api("/api/songs", { name, url: url.href, sharedBy });
        addSong(song);
        urlInput.value = "";
        nameInput.value = "";
        if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur(); // ferme le clavier
        setStatus("Chanson ajoutée !");

        // Fait défiler jusqu'à la nouvelle chanson si elle n'est pas visible
        byId(list, song.id)?.scrollIntoView({ block: "nearest" });
    } catch (err) {
        console.error(err);
        setStatus(err.status === 429
            ? "Beaucoup d’ajouts d’un coup : réessaie dans une minute."
            : "L’ajout n’a pas marché. Vérifie ta connexion puis réessaie.", true);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Ajouter la chanson";
    }
};

// ---------------------------------------------------
// 12)  Chat
// ---------------------------------------------------
chatForm.onsubmit = async e => {
    e.preventDefault();
    const text = chatText.value.trim();
    const sentBy = chatForm.elements.sender.value;
    if (!sentBy) {
        chatError.textContent = "Choisis qui écrit le message.";
        chatForm.elements.sender[0].focus();
        return;
    }
    if (!text || chatSend.disabled) return;

    chatSend.disabled = true;
    try {
        const { message } = await api("/api/messages", { text, sentBy });
        addMessage(message);
        chatText.value = "";
        fitText();
        chatError.textContent = "";
    } catch (err) {
        console.error(err);
        chatError.textContent = err.status === 429
            ? "Beaucoup de messages d’un coup : réessaie dans une minute."
            : "Le message n’est pas parti. Vérifie ta connexion puis réessaie.";
    } finally {
        chatSend.disabled = false;
    }
};

// Entrée envoie, Maj + Entrée va à la ligne
chatText.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        chatForm.requestSubmit();
    }
});

// La zone de texte grandit avec le message (le CSS fixe la hauteur maximale)
function fitText() {
    chatText.style.height = "auto";
    chatText.style.height = chatText.scrollHeight + chatText.offsetHeight - chatText.clientHeight + "px";
}

chatText.addEventListener("input", () => {
    chatError.textContent = "";
    fitText();
});

// ---------------------------------------------------
// 13)  C'est parti : copie de la dernière visite tout de suite, puis le serveur
// ---------------------------------------------------
try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (Array.isArray(cached?.songs) && Array.isArray(cached?.messages)) {
        renderSongs(cached.songs);
        renderMessages(cached.messages);
        shown = true;
    }
} catch { }

sync();
connect();

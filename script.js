// script.js  – module ES, donc chargé avec type="module" ----------------

// ---------------------------------------------------
// 1)  Imports Firebase v12 (CDN)
// ---------------------------------------------------
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-analytics.js";
import {
    getFirestore,
    collection,
    addDoc,
    serverTimestamp,
    query,
    orderBy,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

// ---------------------------------------------------
// 2)  Config de TON projet  (corrige storageBucket !)
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

// ---------------------------------------------------
// 3)  Initialisation Firebase
// ---------------------------------------------------
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);        // facultatif, conserve si utile
const db = getFirestore(app);
const songsCol = collection(db, "songs");

// ---------------------------------------------------
// 4)  Données locales (pochettes) et helpers
// ---------------------------------------------------
const covers = [
    "assets/photos/image.png",
    "assets/photos/image copy.png",
    "assets/photos/image copy 2.png",
    "assets/photos/image copy 3.png",
    "assets/photos/image copy 4.png",
    "assets/photos/image copy 5.png",
    "assets/photos/image copy 6.png",
    "assets/photos/image copy 7.png",
    "assets/photos/image copy 8.png",
    "assets/photos/image copy 9.png",
    "assets/photos/image copy 10.png",
    "assets/photos/image copy 11.png",
    "assets/photos/image copy 12.png",
    "assets/photos/image copy 13.png",
    "assets/photos/image copy 14.png",
    "assets/photos/image copy 15.png",
    "assets/photos/image copy 16.png",
    "assets/photos/image copy 17.png",
    "assets/photos/image copy 18.png",
    "assets/photos/image copy 19.png",
    "assets/photos/image copy 20.png",
    "assets/photos/image copy 21.png",
    "assets/photos/image copy 22.png",
    "assets/photos/image copy 23.png",
    "assets/photos/image copy 24.png",
    "assets/photos/image copy 25.png",
    "assets/photos/image copy 26.png",
    "assets/photos/image copy 27.png",
    "assets/photos/image copy 28.png",
    "assets/photos/image copy 29.png",
    "assets/photos/image copy 30.png",
    "assets/photos/image copy 31.png",
    "assets/photos/image copy 32.png",
    "assets/photos/image copy 33.png",
    "assets/photos/image copy 34.png",
    "assets/photos/image copy 35.png",
    "assets/photos/image copy 36.png",
    "assets/photos/image copy 37.png",
    "assets/photos/image copy 38.png",
    "assets/photos/image copy 39.png",
    "assets/photos/image copy 40.png",
    "assets/photos/image copy 41.png",
    "assets/photos/image copy 42.png",
    "assets/photos/image copy 43.png",
    "assets/photos/image copy 44.png",
    "assets/photos/image copy 45.png",
    "assets/photos/image copy 46.png",
    "assets/photos/image copy 47.png",
    "assets/photos/image copy 48.png",
    "assets/photos/image copy 49.png",
];
const randCover = () => covers[Math.floor(Math.random() * covers.length)];

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

function formatDate(date) {
    const today = new Date();
    const days = Math.round((startOfDay(today) - startOfDay(date)) / 86400000);
    if (days < 7) return relative.format(-Math.max(days, 0), "day");
    return date.toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "long",
        year: date.getFullYear() === today.getFullYear() ? undefined : "numeric"
    });
}

// ---------------------------------------------------
// 5)  Références DOM
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

// ---------------------------------------------------
// 6)  Rendu d’un document
// ---------------------------------------------------
function createSong(doc, isNew) {
    const s = doc.data();

    const li = document.createElement("li");
    li.className = isNew ? "song is-new" : "song";
    li.dataset.id = doc.id;
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
    const cover = s.cover || covers[0];
    img.onerror = () => {
        img.onerror = null;
        img.src = cover;
    };
    img.src = thumbOf(cover);

    updateSong(li, doc);
    return li;
}

// Textes (via textContent : un titre ne peut pas injecter de HTML)
function updateSong(li, doc) {
    const s = doc.data({ serverTimestamps: "estimate" });

    const link = li.querySelector(".song-link");
    const url = parseUrl(s.url);
    if (url) link.href = url.href;
    else link.removeAttribute("href");

    li.querySelector(".song-title").textContent = s.name;

    const sharer = li.querySelector(".song-sharer");
    sharer.textContent = s.sharedBy ?? "";
    sharer.dataset.sharer = s.sharedBy ?? "";

    const date = s.createdAt?.toDate();
    const time = li.querySelector(".song-date");
    time.textContent = date ? formatDate(date) : "";
    if (date) time.dateTime = date.toISOString();
}

// ---------------------------------------------------
// 7)  Écoute Firestore temps-réel
// ---------------------------------------------------
const q = query(songsCol, orderBy("createdAt", "desc"));
let loaded = false;

onSnapshot(q, snap => {
    if (!loaded) list.replaceChildren();        // enlève les lignes de chargement

    // On n'applique que les changements : les autres lignes ne bougent pas
    snap.docChanges().forEach(({ type, doc, oldIndex, newIndex }) => {
        if (type === "added") {
            list.insertBefore(createSong(doc, loaded), list.children[newIndex] ?? null);
            return;
        }
        const li = list.children[oldIndex];
        if (type === "removed") {
            li.remove();
            return;
        }
        updateSong(li, doc);                    // "modified" (ex. date confirmée par le serveur)
        if (newIndex !== oldIndex) {
            li.remove();
            list.insertBefore(li, list.children[newIndex] ?? null);
        }
    });

    loaded = true;
    list.setAttribute("aria-busy", "false");
    songCount.textContent = snap.size || "";
    listStatus.classList.remove("is-error");
    listStatus.textContent = "Pas encore de chanson. Ajoute la première !";
    listStatus.hidden = !snap.empty;
},
    err => {
        console.error("🔥 Firestore snapshot error:", err);
        list.replaceChildren();
        listStatus.classList.add("is-error");
        listStatus.textContent = "Impossible de charger les chansons. Vérifie ta connexion puis recharge la page.";
        listStatus.hidden = false;
    }
);

// ---------------------------------------------------
// 8)  Sélecteur Valentin / Iman (mémorisé sur l'appareil)
// ---------------------------------------------------
const SHARER_KEY = "lastlink-sharer";

try {
    const saved = localStorage.getItem(SHARER_KEY);
    for (const radio of form.elements.sharer) radio.checked = radio.value === saved;
} catch {
    // stockage indisponible (navigation privée…) : on choisit à chaque fois
}

sharerField.addEventListener("change", e => {
    showError(sharerField, "");
    try {
        localStorage.setItem(SHARER_KEY, e.target.value);
    } catch { }
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
// 11)  Soumission du formulaire
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
        const ref = await addDoc(songsCol, {
            name,
            url: url.href,
            sharedBy,
            cover: randCover(),
            createdAt: serverTimestamp()
        });
        urlInput.value = "";
        nameInput.value = "";
        if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur(); // ferme le clavier
        setStatus("Chanson ajoutée !");

        // Fait défiler jusqu'à la nouvelle chanson si elle n'est pas visible
        [...list.children].find(li => li.dataset.id === ref.id)?.scrollIntoView({ block: "nearest" });
    } catch (err) {
        console.error(err);
        setStatus("L’ajout n’a pas marché. Vérifie ta connexion puis réessaie.", true);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Ajouter la chanson";
    }
};

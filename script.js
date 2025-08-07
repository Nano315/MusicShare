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

// ---------------------------------------------------
// 5)  Références DOM
// ---------------------------------------------------
const list = document.getElementById("song-list");
const form = document.getElementById("song-form");
const sharerBtns = document.querySelectorAll(".sharer-btn");
let currentSharer = null;

// ---------------------------------------------------
// 6)  Rendu d’un document
// ---------------------------------------------------
function renderSong(doc) {
    const s = doc.data();

    const li = document.createElement("li");
    li.className = "song-item";
    li.innerHTML = `
    <img src="${s.cover}" width="56" height="56" alt="">
    <div>
      <span class="song-title">${s.name}</span><br>
      <span class="song-sharer">Shared by ${s.sharedBy}</span>
    </div>
  `;
    li.onclick = () => window.open(s.url, "_blank");
    list.append(li);
}

// ---------------------------------------------------
// 7)  Écoute Firestore temps-réel
// ---------------------------------------------------
const q = query(songsCol, orderBy("createdAt", "desc"));
onSnapshot(q, snap => {
    list.innerHTML = "";
    snap.forEach(renderSong);
},
    err => {
        console.error("🔥 Firestore snapshot error:", err);
        alert("Firestore error: " + err.code);   // juste pour voir vite
    }
);


// ---------------------------------------------------
// 8)  Sélecteur Valentin / Iman
// ---------------------------------------------------
sharerBtns.forEach(btn => {
    btn.onclick = () => {
        sharerBtns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentSharer = btn.dataset.sharer;
    };
});

// ---------------------------------------------------
// 9)  Soumission du formulaire
// ---------------------------------------------------
form.onsubmit = async e => {
    e.preventDefault();
    if (!currentSharer) {
        alert("Select Valentin or Iman first.");
        return;
    }

    const name = document.getElementById("song-name").value.trim();
    const url = document.getElementById("song-url").value.trim();

    try {
        await addDoc(songsCol, {
            name,
            url,
            sharedBy: currentSharer,
            cover: randCover(),
            createdAt: serverTimestamp()
        });
        form.reset();
        sharerBtns.forEach(b => b.classList.remove("active"));
        currentSharer = null;
    } catch (err) {
        console.error(err);
        alert("Error saving the song – see console.");
    }
};
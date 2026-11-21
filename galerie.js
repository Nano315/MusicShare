// galerie.js – les photos du site en grand, à enregistrer en qualité d'origine ----------------

// Le site est servi par le serveur LastLink lui-même ; la copie GitHub Pages appelle le homelab
const API = location.hostname.endsWith(".github.io") ? "https://lastlink.nanodev.app" : "";

// Miniature (.webp dans assets/covers/) d'une photo d'origine (.png dans assets/photos/)
const thumbOf = cover => cover.replace("assets/photos/", "assets/covers/").replace(/\.png$/, ".webp");

const grid = document.getElementById("gallery");
const count = document.getElementById("photo-count");
const status = document.getElementById("gallery-status");
const viewer = document.getElementById("viewer");
const viewerImg = document.getElementById("viewer-img");
const caption = document.getElementById("viewer-caption");
const saveBtn = document.getElementById("viewer-save");

let photos = [];
let current = 0;
let original = null;                            // la photo affichée, en fichier, prête à enregistrer

// ---------------------------------------------------
// 1)  La grille de miniatures
// ---------------------------------------------------
async function load() {
    try {
        const res = await fetch(API + "/api/photos");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        ({ photos } = await res.json());
    } catch (err) {
        console.error(err);
        status.textContent = "Impossible de charger les photos pour l’instant. Réessaie dans un moment.";
        status.classList.add("is-error");
        status.hidden = false;
        grid.setAttribute("aria-busy", "false");
        return;
    }

    grid.replaceChildren(...photos.map((cover, i) => {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("aria-label", `Ouvrir la photo ${i + 1}`);
        button.addEventListener("click", () => show(i));

        const img = document.createElement("img");
        img.alt = "";
        img.width = img.height = 192;
        img.loading = "lazy";
        img.decoding = "async";
        img.onerror = () => {                   // pas de miniature : la photo d'origine
            img.onerror = null;
            img.src = cover;
        };
        img.src = thumbOf(cover);
        button.append(img);

        const li = document.createElement("li");
        li.append(button);
        return li;
    }));
    grid.setAttribute("aria-busy", "false");
    count.textContent = photos.length || "";
    status.textContent = "Pas encore de photo.";
    status.hidden = photos.length > 0;
}

// ---------------------------------------------------
// 2)  La visionneuse : la miniature tout de suite, la photo d'origine dès qu'elle est là
// ---------------------------------------------------
function show(index) {
    current = (index + photos.length) % photos.length;
    const shown = current;
    const cover = photos[shown];
    const label = `Photo ${shown + 1} sur ${photos.length}`;

    original = null;
    saveBtn.disabled = true;
    viewerImg.onload = null;
    viewerImg.src = thumbOf(cover);
    viewerImg.alt = label;
    caption.textContent = label;
    if (!viewer.open) viewer.showModal();

    fetch(cover)
        .then(res => res.ok ? res.blob() : Promise.reject(new Error(`HTTP ${res.status}`)))
        .then(blob => {
            if (shown !== current) return;      // on est déjà passé à une autre photo
            original = new File([blob], `lastlink-photo-${shown + 1}.png`, { type: blob.type || "image/png" });
            saveBtn.disabled = false;
            viewerImg.onload = () => {
                if (shown === current) caption.textContent = `${label} · ${viewerImg.naturalWidth} × ${viewerImg.naturalHeight}`;
            };
            viewerImg.src = cover;              // déjà téléchargée : le navigateur la reprend de son cache
        })
        .catch(err => {
            console.error(err);
            if (shown === current) caption.textContent = `${label} · la photo d’origine n’a pas pu être chargée`;
        });
}

// Téléphone : la feuille de partage (« Enregistrer l’image » la range dans Photos) ;
// ordinateur, ou partage impossible : téléchargement du fichier d'origine
saveBtn.addEventListener("click", async () => {
    if (!original) return;
    if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [original] })) {
        try {
            await navigator.share({ files: [original] });
            return;
        } catch (err) {
            if (err.name === "AbortError") return;      // partage annulé
        }
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(original);
    link.download = original.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
});

document.getElementById("viewer-prev").addEventListener("click", () => show(current - 1));
document.getElementById("viewer-next").addEventListener("click", () => show(current + 1));
document.getElementById("viewer-close").addEventListener("click", () => viewer.close());

// Clavier : flèches pour changer de photo (Échap ferme, géré par le navigateur)
viewer.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft") show(current - 1);
    if (e.key === "ArrowRight") show(current + 1);
});

// Glisser le doigt sur la photo : précédente / suivante
let touchX = null;
viewerImg.addEventListener("touchstart", e => {
    touchX = e.touches[0].clientX;
}, { passive: true });
viewerImg.addEventListener("touchend", e => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) show(current + (dx < 0 ? 1 : -1));
});

// Toucher le fond sombre autour de la photo : fermer
viewer.addEventListener("click", e => {
    if (e.target === viewer || e.target.classList.contains("viewer-figure")) viewer.close();
});

load();

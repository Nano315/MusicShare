// galerie.js – les photos du site en grand, à enregistrer en qualité d'origine, et à compléter ----------------

// Le site est servi par le serveur LastLink lui-même ; la copie GitHub Pages appelle le homelab
const API = location.hostname.endsWith(".github.io") ? "https://lastlink.nanodev.app" : "";

// Photo d'origine (site : assets/photos/….png ; ajoutée ici : api/photos/<id>) et sa miniature
const srcOf = cover => cover.startsWith("api/") ? API + "/" + cover : cover;
const thumbOf = cover => cover.startsWith("api/")
    ? srcOf(cover) + "/mini"
    : cover.replace("assets/photos/", "assets/covers/").replace(/\.png$/, ".webp");

const grid = document.getElementById("gallery");
const count = document.getElementById("photo-count");
const status = document.getElementById("gallery-status");
const addBtn = document.getElementById("add-photos");
const fileInput = document.getElementById("photo-input");
const uploadStatus = document.getElementById("upload-status");
const viewer = document.getElementById("viewer");
const viewerImg = document.getElementById("viewer-img");
const caption = document.getElementById("viewer-caption");
const saveBtn = document.getElementById("viewer-save");

let photos = [];
let current = 0;
let original = null;                            // la photo affichée, en fichier, prête à enregistrer

// Valentin ou Iman, choisi sur la page des chansons (même appareil)
const me = (() => {
    try {
        return localStorage.getItem("lastlink-sharer") || "";
    } catch {
        return "";
    }
})();

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

    grid.replaceChildren(...photos.map(({ cover }, i) => {
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
            img.src = srcOf(cover);
        };
        img.src = thumbOf(cover);
        button.append(img);

        const li = document.createElement("li");
        li.append(button);
        return li;
    }));
    grid.setAttribute("aria-busy", "false");
    count.textContent = photos.length || "";
    status.classList.remove("is-error");
    status.textContent = "Pas encore de photo.";
    status.hidden = photos.length > 0;
}

// ---------------------------------------------------
// 2)  Ajouter des photos : le fichier d'origine, puis une miniature faite ici
// ---------------------------------------------------
const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// Petite version pour la liste des chansons et la grille (le petit côté à 320 px)
async function makeMini(file) {
    try {
        const bitmap = await createImageBitmap(file);   // tient compte de l'orientation de la photo
        const scale = Math.min(1, 320 / Math.min(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        return await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.82));
    } catch {
        return null;                            // pas grave : l'originale servira de miniature
    }
}

async function upload(file) {
    if (!EXTENSIONS[file.type]) throw Object.assign(new Error("format"), { reason: "format" });
    const res = await fetch(API + "/api/photos" + (me ? "?par=" + encodeURIComponent(me) : ""), {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { reason: data.error });
    const mini = await makeMini(file);
    if (mini) {
        await fetch(srcOf(data.photo.cover) + "/mini", { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: mini })
            .catch(() => { });
    }
}

function setUploadStatus(message, isError = false) {
    uploadStatus.textContent = message;
    uploadStatus.classList.toggle("is-error", isError);
}

addBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
    const files = [...fileInput.files];
    fileInput.value = "";                       // pouvoir reprendre les mêmes fichiers plus tard
    if (!files.length) return;

    addBtn.disabled = true;
    let added = 0;
    const problems = [];
    for (const [i, file] of files.entries()) {
        setUploadStatus(files.length > 1 ? `Envoi de la photo ${i + 1} sur ${files.length}…` : "Envoi de la photo…");
        try {
            await upload(file);
            added++;
        } catch (err) {
            console.error(err);
            problems.push(err.reason);
        }
    }
    addBtn.disabled = false;

    const reason = problems.includes("format") ? "seules les photos JPEG, PNG ou WebP passent"
        : problems.includes("too_large") ? "une photo dépasse 20 Mo"
            : problems.includes("too_many") ? "trop d’envois d’un coup, réessaie dans une minute"
                : "vérifie ta connexion puis réessaie";
    const done = added === 1 ? "1 photo ajoutée" : `${added} photos ajoutées`;
    if (!problems.length) setUploadStatus(done + " !");
    else if (!added) setUploadStatus(`L’envoi n’a pas marché : ${reason}.`, true);
    else setUploadStatus(`${done}, ${problems.length} non envoyée${problems.length > 1 ? "s" : ""} : ${reason}.`, true);
    if (added) await load();
});

// ---------------------------------------------------
// 3)  La visionneuse : la miniature tout de suite, la photo d'origine dès qu'elle est là
// ---------------------------------------------------
function show(index) {
    current = (index + photos.length) % photos.length;
    const shown = current;
    const { cover, addedBy } = photos[shown];
    const label = `Photo ${shown + 1} sur ${photos.length}` + (addedBy ? ` · ajoutée par ${addedBy}` : "");

    original = null;
    saveBtn.disabled = true;
    viewerImg.onload = null;
    viewerImg.src = thumbOf(cover);
    viewerImg.alt = `Photo ${shown + 1}`;
    caption.textContent = label;
    if (!viewer.open) viewer.showModal();

    fetch(srcOf(cover))
        .then(res => res.ok ? res.blob() : Promise.reject(new Error(`HTTP ${res.status}`)))
        .then(blob => {
            if (shown !== current) return;      // on est déjà passé à une autre photo
            const type = blob.type || "image/png";
            original = new File([blob], `lastlink-photo-${shown + 1}.${EXTENSIONS[type] ?? "png"}`, { type });
            saveBtn.disabled = false;
            viewerImg.onload = () => {
                if (shown === current) caption.textContent = `${label} · ${viewerImg.naturalWidth} × ${viewerImg.naturalHeight}`;
            };
            viewerImg.src = srcOf(cover);       // déjà téléchargée : le navigateur la reprend de son cache
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

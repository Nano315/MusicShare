// Copie les chansons de Firestore dans la base SQLite, sans rien toucher côté
// Firestore (qui reste une sauvegarde). Relançable : une chanson déjà copiée
// (même id) est ignorée, les dates d'origine sont conservées.
//
//   node migrate-firestore.mjs [copie.json]
//
// Lit Firestore par son API REST publique : les chansons y sont lisibles par
// tous, comme sur l'ancien site. Écrit d'abord une copie JSON de tout ce qui
// a été lu (par défaut à côté de la base).

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./server.mjs";

const PROJECT = process.env.FIREBASE_PROJECT || "lastlink-1a510";
const API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyABWMf5IYZbIQfMVrsz8TgitSg8D9dVTRs";

// Document REST de Firestore → ligne de la table songs
export function toSong(doc) {
    const f = doc.fields ?? {};
    const str = key => f[key]?.stringValue ?? "";
    // Firestore donne des nanosecondes : on garde les millisecondes
    const stamp = (f.createdAt?.timestampValue ?? doc.createTime).replace(/(\.\d{3})\d+/, "$1");
    return {
        id: doc.name.split("/").pop(),
        name: str("name"),
        url: str("url"),
        sharedBy: str("sharedBy"),
        cover: str("cover") || "assets/photos/image.png",
        createdAt: new Date(stamp).toISOString()
    };
}

export async function fetchSongs() {
    const songs = [];
    let pageToken = "";
    do {
        const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/songs`
            + `?pageSize=300&key=${API_KEY}` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Firestore a répondu ${res.status} : ${await res.text()}`);
        const page = await res.json();
        for (const doc of page.documents ?? []) songs.push(toSong(doc));
        pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return songs;
}

// Ajoute les chansons absentes (tout ou rien) ; renvoie le nombre ajouté
export function importSongs(db, songs) {
    const insert = db.prepare(
        "INSERT OR IGNORE INTO songs (id, name, url, shared_by, cover, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    let added = 0;
    db.exec("BEGIN");
    try {
        for (const s of songs) added += Number(insert.run(s.id, s.name, s.url, s.sharedBy, s.cover, s.createdAt).changes);
        db.exec("COMMIT");
    } catch (err) {
        db.exec("ROLLBACK");
        throw err;
    }
    return added;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const dbPath = process.env.DB_PATH || "./data/lastlink.db";
    const backup = process.argv[2] || join(dirname(dbPath), `firestore-songs-${new Date().toISOString().slice(0, 10)}.json`);

    const songs = await fetchSongs();
    const db = openDb(dbPath);
    writeFileSync(backup, JSON.stringify(songs, null, 2));
    const added = importSongs(db, songs);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM songs").get();
    db.close();
    console.log(`${songs.length} chansons lues dans Firestore (copie : ${backup}) — ${added} ajoutées, ${n} dans la base.`);
}

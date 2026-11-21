// Serveur de LastLink : sert le site, et les chansons et le chat, rangés dans
// SQLite et envoyés en direct aux pages ouvertes (Server-Sent Events).
// node:http + node:sqlite (Node 24), aucune dépendance.

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomInt, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PEOPLE = ["Valentin", "Iman"];
const MAX_BODY = 16 * 1024;
const MAX_STREAMS = 200;
const MESSAGES_SHOWN = 300;
const COVER = /^assets\/photos\/image( copy( \d{1,3})?)?\.png$/;
const MAX_PHOTO = 20 * 1024 * 1024;             // une photo de téléphone, même grande
const MAX_MINI = 512 * 1024;                    // sa miniature, faite par la page
const MAX_PHOTOS = 300;                         // photos ajoutées depuis la galerie, en tout

// Fichiers du site que le serveur accepte d'envoyer (tout autre type : 404)
const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml"
};

// ---------------------------------------------------
// 1)  Base SQLite (mêmes champs que l'ancienne collection Firestore)
// ---------------------------------------------------
export function openDb(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 3000;
        CREATE TABLE IF NOT EXISTS songs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            shared_by TEXT NOT NULL,
            cover TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS songs_created ON songs(created_at);
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            sent_by TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
        CREATE TABLE IF NOT EXISTS photos (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            data BLOB NOT NULL,
            mini BLOB,
            added_by TEXT,
            created_at TEXT NOT NULL
        );
    `);
    return db;
}

// ---------------------------------------------------
// 2)  Vérification de ce qu'envoie la page
// ---------------------------------------------------
class HttpError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

// Texte nettoyé, ou null s'il est vide ou trop long
function text(value, max) {
    if (typeof value !== "string") return null;
    const v = value.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return v && v.length <= max ? v : null;
}

// Seuls les liens web passent (pas de "javascript:", "data:"…)
function webUrl(value) {
    if (typeof value !== "string" || value.length > 2048) return null;
    try {
        const url = new URL(value.trim());
        return /^https?:$/.test(url.protocol) && url.hostname.includes(".") ? url.href : null;
    } catch {
        return null;
    }
}

const person = value => PEOPLE.includes(value) ? value : null;

async function readJson(req) {
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) throw new HttpError(415, "json_expected");
    if (Number(req.headers["content-length"]) > MAX_BODY) throw new HttpError(413, "too_large");
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new HttpError(413, "too_large");
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) ?? {};
    } catch {
        throw new HttpError(400, "bad_json");
    }
}

// Corps brut (une photo), au plus `max` octets
async function readBody(req, max) {
    if (Number(req.headers["content-length"]) > max) throw new HttpError(413, "too_large");
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > max) throw new HttpError(413, "too_large");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

const asBuffer = bytes => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// Type réel d'une image d'après ses premiers octets (on ne se fie pas à ce qu'annonce la page)
function imageType(buf) {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
    if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
    return null;
}

// Les photos de téléphone gardent souvent l'endroit où elles ont été prises (EXIF GPS).
// Le site est public : on efface ces coordonnées du fichier, sans toucher à l'image.
export function stripGps(buf) {
    if (imageType(buf) !== "image/jpeg") return buf;
    let pos = 2;
    while (pos + 4 <= buf.length && buf[pos] === 0xff) {
        const marker = buf[pos + 1];
        if (marker === 0xda || marker === 0xd9) break;          // l'image commence : plus de métadonnées
        const end = Math.min(pos + 2 + buf.readUInt16BE(pos + 2), buf.length);
        if (marker === 0xe1 && buf.toString("latin1", pos + 4, pos + 10) === "Exif\0\0") blankGps(buf, pos + 10, end);
        pos = end;
    }
    return buf;
}

// Dans le bloc EXIF (au format TIFF) : vide le répertoire GPS et les valeurs qu'il désigne
function blankGps(buf, tiff, end) {
    if (tiff + 8 > end) return;
    const le = buf.toString("latin1", tiff, tiff + 2) === "II";
    const u16 = at => le ? buf.readUInt16LE(at) : buf.readUInt16BE(at);
    const u32 = at => le ? buf.readUInt32LE(at) : buf.readUInt32BE(at);
    const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
    const ifd0 = tiff + u32(tiff + 4);
    if (ifd0 + 2 > end) return;
    for (let i = 0, n = u16(ifd0); i < n; i++) {
        const entry = ifd0 + 2 + i * 12;
        if (entry + 12 > end) return;
        if (u16(entry) !== 0x8825) continue;                    // GPSInfo
        const gps = tiff + u32(entry + 8);
        if (gps + 2 > end) return;
        for (let j = 0, count = u16(gps); j < count; j++) {
            const field = gps + 2 + j * 12;
            if (field + 12 > end) break;
            const bytes = (SIZE[u16(field + 2)] ?? 1) * u32(field + 4);
            const at = tiff + u32(field + 8);
            if (bytes > 4 && at + bytes <= end) buf.fill(0, at, at + bytes);
            buf.fill(0, field, field + 12);
        }
        if (le) buf.writeUInt16LE(0, gps);
        else buf.writeUInt16BE(0, gps);
    }
}

// Anti-flood : au plus `perIp` envois par minute et par adresse, `total` en tout
function limiter({ perIp, total }) {
    let windowStart = 0;
    let all = 0;
    const byIp = new Map();
    return ip => {
        const now = Date.now();
        if (now - windowStart >= 60_000) {
            windowStart = now;
            all = 0;
            byIp.clear();
        }
        const n = (byIp.get(ip) ?? 0) + 1;
        if (n > perIp || all >= total) return false;
        byIp.set(ip, n);
        all++;
        return true;
    };
}

// ---------------------------------------------------
// 3)  Serveur HTTP
// ---------------------------------------------------
export function createApp({ db, origins = [], staticDir = "", limits = { perIp: 10, total: 60 } }) {
    const allowed = new Set(origins);
    const siteRoot = staticDir && resolve(staticDir);
    const canWrite = limiter(limits);
    const streams = new Set();

    const SONG = "id, name, url, shared_by AS sharedBy, cover, created_at AS createdAt";
    const q = {
        songs: db.prepare(`SELECT ${SONG} FROM songs ORDER BY created_at DESC, rowid DESC`),
        addSong: db.prepare("INSERT INTO songs (id, name, url, shared_by, cover, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
        // Les derniers messages, remis dans l'ordre de lecture (du plus ancien au plus récent)
        messages: db.prepare(`
            SELECT id, text, sentBy, createdAt FROM (
                SELECT id, text, sent_by AS sentBy, created_at AS createdAt, rowid AS r
                FROM messages ORDER BY created_at DESC, rowid DESC LIMIT ?
            ) ORDER BY createdAt, r
        `),
        addMessage: db.prepare("INSERT INTO messages (id, text, sent_by, created_at) VALUES (?, ?, ?, ?)"),
        count: db.prepare("SELECT (SELECT COUNT(*) FROM songs) AS songs, (SELECT COUNT(*) FROM messages) AS messages"),
        coverUses: db.prepare("SELECT cover, COUNT(*) AS n FROM songs GROUP BY cover"),
        // Photos ajoutées depuis la galerie : le fichier d'origine et sa miniature
        photos: db.prepare("SELECT id, added_by AS addedBy, created_at AS createdAt FROM photos ORDER BY created_at DESC, rowid DESC"),
        photoFile: db.prepare("SELECT type, data FROM photos WHERE id = ?"),
        photoMini: db.prepare("SELECT mini, created_at AS createdAt FROM photos WHERE id = ?"),
        addPhoto: db.prepare("INSERT INTO photos (id, type, data, added_by, created_at) VALUES (?, ?, ?, ?, ?)"),
        setMini: db.prepare("UPDATE photos SET mini = ? WHERE id = ? AND mini IS NULL"),
        photoCount: db.prepare("SELECT COUNT(*) AS n FROM photos")
    };

    const canUpload = limiter({ perIp: 20, total: 100 });

    // Photos du site (assets/photos/)
    async function sitePhotos() {
        if (!siteRoot) return [];
        const files = await readdir(join(siteRoot, "assets", "photos")).catch(() => []);
        return files.map(file => "assets/photos/" + file).filter(cover => COVER.test(cover));
    }

    // Photos que le serveur peut donner aux chansons : celles du site et celles ajoutées depuis la galerie
    async function coverPool() {
        return [...await sitePhotos(), ...q.photos.all().map(({ id }) => "api/photos/" + id)];
    }

    // Une photo ajoutée : jamais modifiée une fois envoyée, donc gardée en cache pour de bon
    function servePhoto(req, res, headers, id, wantsMini) {
        const mini = wantsMini ? q.photoMini.get(id)?.mini : null;
        const data = mini ?? q.photoFile.get(id)?.data;
        if (!data) throw new HttpError(404, "not_found");
        // pas encore de miniature : l'originale la remplace, sans être gardée en cache
        const cache = wantsMini && !mini ? "no-cache" : "public, max-age=31536000, immutable";
        const etag = `"${id}${mini ? "-mini" : ""}"`;
        if (req.headers["if-none-match"] === etag) {
            res.writeHead(304, { ...headers, ETag: etag, "Cache-Control": cache });
            return res.end();
        }
        res.writeHead(200, {
            ...headers,
            "Content-Type": imageType(asBuffer(data)) ?? "application/octet-stream",
            "Content-Length": data.byteLength,
            ETag: etag,
            "Cache-Control": cache,
            "X-Content-Type-Options": "nosniff"
        });
        res.end(req.method === "HEAD" ? undefined : data);
    }

    // La miniature, faite par la page juste après l'envoi : une seule fois, dans les 10 minutes
    async function saveMini(req, res, headers, id) {
        const body = await readBody(req, MAX_MINI);
        const photo = q.photoMini.get(id);
        if (!photo) throw new HttpError(404, "not_found");
        if (photo.mini || Date.now() - Date.parse(photo.createdAt) > 10 * 60_000) throw new HttpError(409, "already_set");
        if (!imageType(body)) throw new HttpError(415, "not_an_image");
        q.setMini.run(body, id);
        res.writeHead(204, headers);
        res.end();
    }

    // Ordre de la galerie : "image.png", "image copy.png", puis "image copy 2.png", "image copy 3.png"…
    function photoRank(cover) {
        const [, copy, n] = cover.match(/image( copy(?: (\d+))?)?\.png$/);
        return !copy ? 0 : n ? Number(n) + 1 : 1;
    }

    // La photo la moins utilisée, au hasard parmi les ex æquo : aucun doublon tant
    // qu'il reste une photo libre, puis celles qui ne servent qu'une fois, etc.
    function leastUsed(photos) {
        const uses = new Map(photos.map(cover => [cover, 0]));
        for (const { cover, n } of q.coverUses.all()) if (uses.has(cover)) uses.set(cover, n);
        const least = Math.min(...uses.values());
        const candidates = photos.filter(cover => uses.get(cover) === least);
        return candidates[randomInt(candidates.length)];
    }

    // La copie du site sur GitHub Pages est sur un autre domaine : on l'autorise explicitement
    function cors(req) {
        const origin = req.headers.origin;
        return origin && allowed.has(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
    }

    function send(res, status, body, headers) {
        res.writeHead(status, {
            ...headers,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
        });
        res.end(JSON.stringify(body));
    }

    // Prévient toutes les pages ouvertes
    function broadcast(event, data) {
        const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of streams) res.write(chunk);
    }

    function openStream(req, res, headers) {
        if (streams.size >= MAX_STREAMS) throw new HttpError(503, "busy");
        res.writeHead(200, {
            ...headers,
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no"
        });
        res.write("retry: 5000\n\n");
        streams.add(res);
        res.on("close", () => streams.delete(res));   // page fermée ou réseau coupé
    }

    // Le site lui-même : index.html, script.js, styles.css, assets/
    async function serveFile(req, res, pathname) {
        let path;
        try {
            path = decodeURIComponent(pathname);
        } catch {
            throw new HttpError(400, "bad_path");
        }
        if (path.endsWith("/")) path += "index.html";
        const file = normalize(join(siteRoot, path));
        const type = TYPES[extname(file).toLowerCase()];
        // jamais rien en dehors du dossier du site (ex. /..%2f…)
        const info = type && file.startsWith(siteRoot + sep) ? await stat(file).catch(() => null) : null;
        if (!info?.isFile()) throw new HttpError(404, "not_found");

        const etag = `W/"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
        // Les images bougent peu ; le reste est revérifié à chaque visite (304 si rien n'a changé)
        const cache = path.startsWith("/assets/") ? "public, max-age=604800" : "no-cache";
        if (req.headers["if-none-match"] === etag) {
            res.writeHead(304, { ETag: etag, "Cache-Control": cache });
            return res.end();
        }
        res.writeHead(200, {
            "Content-Type": type,
            "Content-Length": info.size,
            ETag: etag,
            "Cache-Control": cache,
            "X-Content-Type-Options": "nosniff"
        });
        if (req.method === "HEAD") return res.end();
        createReadStream(file).on("error", () => res.destroy()).pipe(res);
    }

    const ipOf = req => req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "";

    async function route(req, res, headers) {
        const { pathname } = new URL(req.url, "http://localhost");

        if (req.method === "OPTIONS") {
            res.writeHead(204, headers["Access-Control-Allow-Origin"] ? {
                ...headers,
                "Access-Control-Allow-Methods": "GET, POST, PUT",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Max-Age": "86400"
            } : {});
            return res.end();
        }
        if ((req.method === "POST" || req.method === "PUT") && req.headers.origin && !allowed.has(req.headers.origin)) {
            throw new HttpError(403, "origin");
        }

        // Une photo ajoutée : /api/photos/<id> (l'originale) ou /api/photos/<id>/mini (sa miniature)
        const photoPath = pathname.match(/^\/api\/photos\/([0-9a-f-]{36})(\/mini)?$/);
        if (photoPath && (req.method === "GET" || req.method === "HEAD")) return servePhoto(req, res, headers, photoPath[1], !!photoPath[2]);
        if (photoPath?.[2] && req.method === "PUT") return saveMini(req, res, headers, photoPath[1]);

        switch (`${req.method} ${pathname}`) {
            case "GET /api/health":
                return send(res, 200, { ok: true, ...q.count.get() }, headers);

            case "GET /api/songs":
                return send(res, 200, { songs: q.songs.all() }, headers);

            case "POST /api/songs": {
                const body = await readJson(req);
                // Le serveur choisit la photo ; sans aucune photo (tests), il prend celle proposée par la page
                const photos = await coverPool();
                const proposed = typeof body.cover === "string" && COVER.test(body.cover) ? body.cover : null;
                const song = {
                    id: randomUUID(),
                    name: text(body.name, 200),
                    url: webUrl(body.url),
                    sharedBy: person(body.sharedBy),
                    cover: photos.length ? "" : proposed,
                    createdAt: new Date().toISOString()
                };
                const invalid = ["name", "url", "sharedBy"].find(key => !song[key]) ?? (song.cover === null && "cover");
                if (invalid) throw new HttpError(400, "invalid_" + invalid);
                if (!canWrite(ipOf(req))) throw new HttpError(429, "too_many");
                // Choix et ajout sans attente entre les deux : deux ajouts simultanés ne prennent pas la même photo libre
                if (photos.length) song.cover = leastUsed(photos);
                q.addSong.run(song.id, song.name, song.url, song.sharedBy, song.cover, song.createdAt);
                broadcast("song", song);
                return send(res, 201, { song }, headers);
            }

            case "GET /api/messages":
                return send(res, 200, { messages: q.messages.all(MESSAGES_SHOWN) }, headers);

            case "POST /api/messages": {
                const body = await readJson(req);
                const message = {
                    id: randomUUID(),
                    text: text(body.text, 1000),
                    sentBy: person(body.sentBy),
                    createdAt: new Date().toISOString()
                };
                const invalid = ["text", "sentBy"].find(key => !message[key]);
                if (invalid) throw new HttpError(400, "invalid_" + invalid);
                if (!canWrite(ipOf(req))) throw new HttpError(429, "too_many");
                q.addMessage.run(message.id, message.text, message.sentBy, message.createdAt);
                broadcast("message", message);
                return send(res, 201, { message }, headers);
            }

            // La galerie : les photos ajoutées (la plus récente d'abord), puis celles du site
            case "GET /api/photos": {
                const added = q.photos.all().map(({ id, addedBy, createdAt }) => ({ cover: "api/photos/" + id, addedBy, createdAt }));
                const site = (await sitePhotos()).sort((a, b) => photoRank(a) - photoRank(b)).map(cover => ({ cover }));
                return send(res, 200, { photos: [...added, ...site] }, headers);
            }

            // Une photo envoyée depuis la galerie : gardée telle quelle, sans ses coordonnées GPS
            case "POST /api/photos": {
                const data = stripGps(await readBody(req, MAX_PHOTO));
                const type = imageType(data);
                if (!type) throw new HttpError(415, "not_an_image");
                if (q.photoCount.get().n >= MAX_PHOTOS) throw new HttpError(507, "full");
                if (!canUpload(ipOf(req))) throw new HttpError(429, "too_many");
                const photo = {
                    cover: "api/photos/" + randomUUID(),
                    addedBy: person(new URL(req.url, "http://localhost").searchParams.get("par")),
                    createdAt: new Date().toISOString()
                };
                q.addPhoto.run(photo.cover.slice("api/photos/".length), type, data, photo.addedBy, photo.createdAt);
                return send(res, 201, { photo }, headers);
            }

            case "GET /api/events":
                return openStream(req, res, headers);
        }
        if (siteRoot && (req.method === "GET" || req.method === "HEAD") && !pathname.startsWith("/api/")) {
            return serveFile(req, res, pathname);
        }
        throw new HttpError(404, "not_found");
    }

    const server = createServer(async (req, res) => {
        const headers = cors(req);
        try {
            await route(req, res, headers);
        } catch (err) {
            if (!(err instanceof HttpError)) console.error(err);
            if (res.headersSent) return res.end();
            const status = err instanceof HttpError ? err.status : 500;
            send(res, status, { error: err instanceof HttpError ? err.code : "server" }, headers);
        }
    });

    // Cloudflare coupe une connexion muette au bout de 100 s : petit signe de vie
    const ping = setInterval(() => {
        for (const res of streams) res.write(": ping\n\n");
    }, 25_000);
    ping.unref();
    server.on("close", () => clearInterval(ping));

    return server;
}

// ---------------------------------------------------
// 4)  Lancement (node server.mjs)
// ---------------------------------------------------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const db = openDb(process.env.DB_PATH || "./data/lastlink.db");
    const server = createApp({
        db,
        origins: (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean),
        staticDir: process.env.STATIC_DIR || ""
    });
    const port = Number(process.env.PORT || 8136);
    server.listen(port, () => console.log(`LastLink écoute sur le port ${port}`));

    const stop = () => {
        server.close(() => {
            db.close();
            process.exit(0);
        });
        server.closeAllConnections();               // les flux en direct ne se ferment pas seuls
        setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
}

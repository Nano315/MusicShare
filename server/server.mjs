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
        coverUses: db.prepare("SELECT cover, COUNT(*) AS n FROM songs GROUP BY cover")
    };

    // Photos que le serveur peut donner aux chansons : celles du site (assets/photos/)
    async function sitePhotos() {
        if (!siteRoot) return [];
        const files = await readdir(join(siteRoot, "assets", "photos")).catch(() => []);
        return files.map(file => "assets/photos/" + file).filter(cover => COVER.test(cover));
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

    // Les copies du site (GitHub Pages, Vercel) sont sur d'autres domaines : on les autorise explicitement
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
                "Access-Control-Allow-Methods": "GET, POST",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Max-Age": "86400"
            } : {});
            return res.end();
        }
        if (req.method === "POST" && req.headers.origin && !allowed.has(req.headers.origin)) {
            throw new HttpError(403, "origin");
        }

        switch (`${req.method} ${pathname}`) {
            case "GET /api/health":
                return send(res, 200, { ok: true, ...q.count.get() }, headers);

            case "GET /api/songs":
                return send(res, 200, { songs: q.songs.all() }, headers);

            case "POST /api/songs": {
                const body = await readJson(req);
                // Le serveur choisit la photo ; sans photos de site (tests), il prend celle proposée par la page
                const photos = await sitePhotos();
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

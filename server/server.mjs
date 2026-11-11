// Serveur de LastLink : les chansons et le chat, rangés dans SQLite et envoyés
// en direct aux pages ouvertes (Server-Sent Events).
// node:http + node:sqlite (Node 24), aucune dépendance.

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PEOPLE = ["Valentin", "Iman"];
const MAX_BODY = 16 * 1024;
const MAX_STREAMS = 200;
const MESSAGES_SHOWN = 300;
const COVER = /^assets\/photos\/image( copy( \d{1,3})?)?\.png$/;

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
export function createApp({ db, origins = [], frontUrl = "", limits = { perIp: 10, total: 60 } }) {
    const allowed = new Set(origins);
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
        count: db.prepare("SELECT (SELECT COUNT(*) FROM songs) AS songs, (SELECT COUNT(*) FROM messages) AS messages")
    };

    // La page est sur un autre domaine (Vercel) : on l'autorise explicitement
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
            case "GET /":
                if (!frontUrl) break;
                res.writeHead(302, { Location: frontUrl });
                return res.end();

            case "GET /api/health":
                return send(res, 200, { ok: true, ...q.count.get() }, headers);

            case "GET /api/songs":
                return send(res, 200, { songs: q.songs.all() }, headers);

            case "POST /api/songs": {
                const body = await readJson(req);
                const song = {
                    id: randomUUID(),
                    name: text(body.name, 200),
                    url: webUrl(body.url),
                    sharedBy: person(body.sharedBy),
                    cover: typeof body.cover === "string" && COVER.test(body.cover) ? body.cover : null,
                    createdAt: new Date().toISOString()
                };
                const invalid = ["name", "url", "sharedBy", "cover"].find(key => !song[key]);
                if (invalid) throw new HttpError(400, "invalid_" + invalid);
                if (!canWrite(ipOf(req))) throw new HttpError(429, "too_many");
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
        frontUrl: process.env.FRONT_URL || ""
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

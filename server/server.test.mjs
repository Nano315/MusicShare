// Tests du serveur : node --test (aucune dépendance, base en mémoire)

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, createApp } from "./server.mjs";
import { toSong, importSongs } from "./migrate-firestore.mjs";

const FRONT = "https://front.test";
const servers = [];

async function start(limits = { perIp: 1000, total: 1000 }, staticDir = "") {
    const db = openDb(":memory:");
    const server = createApp({ db, origins: [FRONT], staticDir, limits });
    await new Promise(done => server.listen(0, "127.0.0.1", done));
    servers.push({ server, db });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body, headers = {}) => fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body)
    });
    return { base, db, post };
}

after(() => {
    for (const { server, db } of servers) {
        server.closeAllConnections();
        server.close();
        db.close();
    }
});

const SONG = {
    name: "Nuit étoilée",
    url: "https://open.spotify.com/track/abc",
    sharedBy: "Iman",
    cover: "assets/photos/image copy 12.png"
};

test("santé, et aucun fichier servi sans dossier de site", async () => {
    const { base } = await start();
    assert.deepEqual(await (await fetch(base + "/api/health")).json(), { ok: true, songs: 0, messages: 0 });
    assert.equal((await fetch(base + "/")).status, 404);
    assert.equal((await fetch(base + "/nope")).status, 404);
});

test("le site : fichiers, cache et rien en dehors du dossier", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lastlink-"));
    const site = join(tmp, "site");
    mkdirSync(join(site, "assets", "covers"), { recursive: true });
    writeFileSync(join(site, "index.html"), "<!doctype html><title>LastLink</title>");
    writeFileSync(join(site, "script.js"), "console.log(1);");
    writeFileSync(join(site, "assets", "covers", "image copy 1.webp"), "webp");
    writeFileSync(join(site, "notes.md"), "privé");
    writeFileSync(join(tmp, "secret.html"), "hors du site");

    const { base } = await start(undefined, site);
    const home = await fetch(base + "/");
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(home.headers.get("cache-control"), "no-cache");
    assert.equal(await home.text(), "<!doctype html><title>LastLink</title>");

    // même fichier inchangé : 304 sans corps
    const again = await fetch(base + "/index.html", { headers: { "If-None-Match": home.headers.get("etag") } });
    assert.equal(again.status, 304);

    const js = await fetch(base + "/script.js?v=4");
    assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    const cover = await fetch(base + "/assets/covers/image%20copy%201.webp");
    assert.equal(cover.headers.get("content-type"), "image/webp");
    assert.equal(cover.headers.get("cache-control"), "public, max-age=604800");

    const head = await fetch(base + "/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    for (const [path, status] of [["/..%2fsecret.html", 404], ["/notes.md", 404], ["/assets", 404], ["/api/nope", 404], ["/%E0%A4%A", 400]]) {
        assert.equal((await fetch(base + path)).status, status, path);
    }
    assert.equal((await fetch(base + "/", { method: "POST" })).status, 404);
    rmSync(tmp, { recursive: true, force: true });
});

test("ajout et liste des chansons, la plus récente d'abord", async () => {
    const { base, post } = await start();
    const first = await post("/api/songs", SONG);
    assert.equal(first.status, 201);
    const { song } = await first.json();
    assert.equal(song.name, "Nuit étoilée");
    assert.equal(song.sharedBy, "Iman");
    assert.ok(!Number.isNaN(Date.parse(song.createdAt)));

    await post("/api/songs", { ...SONG, name: "  Deuxième  ", sharedBy: "Valentin", url: "https://youtu.be/xyz" });
    const { songs } = await (await fetch(base + "/api/songs")).json();
    assert.deepEqual(songs.map(s => s.name), ["Deuxième", "Nuit étoilée"]);
    assert.deepEqual(Object.keys(songs[0]).sort(), ["cover", "createdAt", "id", "name", "sharedBy", "url"]);
});

test("refuse les chansons invalides", async () => {
    const { post } = await start();
    const cases = [
        [{ ...SONG, url: "javascript:alert(1)" }, 400, "invalid_url"],
        [{ ...SONG, url: "ftp://exemple.com/a" }, 400, "invalid_url"],
        [{ ...SONG, url: "https://localhost/x" }, 400, "invalid_url"],
        [{ ...SONG, name: "   " }, 400, "invalid_name"],
        [{ ...SONG, name: "x".repeat(201) }, 400, "invalid_name"],
        [{ ...SONG, sharedBy: "Bob" }, 400, "invalid_sharedBy"],
        [{ ...SONG, cover: "../../etc/passwd" }, 400, "invalid_cover"],
        ["{pas du json", 400, "bad_json"],
        [{ ...SONG, name: "x".repeat(20000) }, 413, "too_large"]
    ];
    for (const [body, status, error] of cases) {
        const res = await post("/api/songs", body);
        assert.equal(res.status, status, error);
        assert.equal((await res.json()).error, error);
    }
    const plain = await post("/api/songs", JSON.stringify(SONG), { "Content-Type": "text/plain" });
    assert.equal(plain.status, 415);
});

test("messages : ajout, nettoyage et ordre de lecture", async () => {
    const { base, post } = await start();
    for (const [text, sentBy] of [["Coucou", "Valentin"], ["  Salut\r\n\r\n\r\n\r\ntoi  ", "Iman"]]) {
        assert.equal((await post("/api/messages", { text, sentBy })).status, 201);
    }
    const { messages } = await (await fetch(base + "/api/messages")).json();
    assert.deepEqual(messages.map(m => [m.text, m.sentBy]), [["Coucou", "Valentin"], ["Salut\n\ntoi", "Iman"]]);
    assert.deepEqual(Object.keys(messages[0]).sort(), ["createdAt", "id", "sentBy", "text"]);

    for (const [body, error] of [
        [{ text: " ", sentBy: "Iman" }, "invalid_text"],
        [{ text: "x".repeat(1001), sentBy: "Iman" }, "invalid_text"],
        [{ text: "Hey", sentBy: "iman" }, "invalid_sentBy"]
    ]) {
        const res = await post("/api/messages", body);
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, error);
    }
});

test("CORS : seul le site est autorisé", async () => {
    const { base, post } = await start();
    const ok = await fetch(base + "/api/songs", { headers: { Origin: FRONT } });
    assert.equal(ok.headers.get("access-control-allow-origin"), FRONT);
    const other = await fetch(base + "/api/songs", { headers: { Origin: "https://ailleurs.test" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);

    const preflight = await fetch(base + "/api/messages", {
        method: "OPTIONS",
        headers: { Origin: FRONT, "Access-Control-Request-Method": "POST" }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-headers"), "Content-Type");

    const foreign = await post("/api/messages", { text: "Hey", sentBy: "Iman" }, { Origin: "https://ailleurs.test" });
    assert.equal(foreign.status, 403);
});

test("anti-flood par adresse", async () => {
    const { post } = await start({ perIp: 2, total: 100 });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post("/api/messages", { text: "Hey " + i, sentBy: "Iman" })).status);
    assert.deepEqual(statuses, [201, 201, 429]);
    // l'adresse vue par Cloudflare compte à part
    const other = await post("/api/messages", { text: "Hey", sentBy: "Iman" }, { "CF-Connecting-IP": "203.0.113.7" });
    assert.equal(other.status, 201);
});

test("les pages ouvertes reçoivent chansons et messages en direct", async () => {
    const { base, post } = await start();
    const stream = await fetch(base + "/api/events", { headers: { Origin: FRONT } });
    assert.equal(stream.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(stream.headers.get("access-control-allow-origin"), FRONT);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const until = async needle => {
        while (!received.includes(needle)) received += decoder.decode((await reader.read()).value);
    };
    await until("retry: 5000");

    await post("/api/messages", { text: "En direct", sentBy: "Valentin" });
    await post("/api/songs", SONG);
    await until("event: song");
    await reader.cancel();

    const events = received.split("\n\n").filter(e => e.startsWith("event:"));
    assert.equal(events.length, 2);
    assert.match(events[0], /^event: message\ndata: \{.*"text":"En direct"/);
    assert.match(events[1], /^event: song\ndata: \{.*"name":"Nuit étoilée"/);
});

test("migration : documents Firestore copiés une seule fois, dates conservées", async () => {
    const docs = [
        {
            name: "projects/p/databases/(default)/documents/songs/abc123",
            createTime: "2025-01-01T00:00:00.000000Z",
            fields: {
                name: { stringValue: "Ancienne" },
                url: { stringValue: "https://deezer.com/track/1" },
                sharedBy: { stringValue: "Valentin" },
                cover: { stringValue: "assets/photos/image copy 3.png" },
                createdAt: { timestampValue: "2025-08-10T12:34:56.789123Z" }
            }
        },
        {
            name: "projects/p/databases/(default)/documents/songs/def456",
            createTime: "2025-09-02T08:00:00.123456789Z",
            fields: { name: { stringValue: "Sans date ni pochette" }, url: { stringValue: "https://x.com/a" }, sharedBy: { stringValue: "Iman" } }
        }
    ];
    const songs = docs.map(toSong);
    assert.deepEqual(songs[0], {
        id: "abc123",
        name: "Ancienne",
        url: "https://deezer.com/track/1",
        sharedBy: "Valentin",
        cover: "assets/photos/image copy 3.png",
        createdAt: "2025-08-10T12:34:56.789Z"
    });
    assert.equal(songs[1].createdAt, "2025-09-02T08:00:00.123Z");
    assert.equal(songs[1].cover, "assets/photos/image.png");

    const { base, db, post } = await start();
    assert.equal(importSongs(db, songs), 2);
    assert.equal(importSongs(db, songs), 0);            // relancer ne duplique rien
    await post("/api/songs", SONG);
    const list = (await (await fetch(base + "/api/songs")).json()).songs;
    assert.deepEqual(list.map(s => s.id).slice(1), ["def456", "abc123"]);
    assert.equal(list[2].createdAt, "2025-08-10T12:34:56.789Z");
});

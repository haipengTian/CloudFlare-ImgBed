import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest as upload } from '../../../functions/upload/index.js';
import { onRequest as read } from '../../../functions/file/[[path]].js';
import { deleteFile } from '../../../functions/api/manage/delete/[[path]].js';
import { TelegramAPI } from '../../../functions/utils/storage/telegramAPI.js';

test('unified private storage uses ImageBed Telegram default, preserves bytes and hides direct links', async t => {
    const records = new Map();
    const files = new Map();
    const token = 'synthetic-telegram-token';
    const tasks = [];
    records.set('manage@sysConfig@security', { value: JSON.stringify({ apiTokens: { tokens: { trial: { token, permissions: ['upload', 'manage', 'delete'] } } } }) });
    records.set('manage@sysConfig@upload', { value: JSON.stringify({ telegram: { channels: [{ name: 'existing-tg', enabled: true, botToken: 'synthetic-bot', chatId: '-10001' }] } }) });
    globalThis.caches = { default: { async put() {}, async delete() {} } };
    const env = { img_url: {
        async get(k) { return records.get(k)?.value ?? null; },
        async getWithMetadata(k) { return records.get(k) ?? null; },
        async put(k, value, options) { records.set(k, { value, metadata: structuredClone(options?.metadata) }); },
        async delete(k) { records.delete(k); },
        async list() { return { keys: [], list_complete: true }; },
    } };
    // No real Telegram/ImgBed traffic and no credentials from user storage.
    t.mock.method(TelegramAPI.prototype, 'getChat', async () => ({ type: 'channel' }));
    t.mock.method(TelegramAPI.prototype, 'getFilePath', async () => 'synthetic-path');
    t.mock.method(TelegramAPI.prototype, 'sendFile', async (file, chat, fn, kind) => {
        assert.equal(fn, 'sendDocument'); assert.equal(kind, 'document');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const id = `file-${files.size}`; files.set(id, bytes);
        return { ok: true, result: { document: { file_id: id, file_size: bytes.length } } };
    });
    t.mock.method(TelegramAPI.prototype, 'getFileContent', async id => new Response(files.get(id)));
    const context = (request, object) => ({ request, env, params: { path: object }, waitUntil(p) { tasks.push(p.catch(() => {})); } });
    const headers = { Authorization: `Bearer ${token}` };
    // Image MIME must still use lossless document storage. The large object
    // exercises ImageBed's existing internal Telegram split, not client chunks.
    for (const size of [6, 16 * 1024 * 1024 + 7]) {
        const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
        const object = `cloudreve-test/1/file-${size}.png`;
        const send = () => {
            const form = new FormData(); form.set('file', new Blob([bytes], { type: 'image/png' }), `file-${size}.png`);
            return upload(context(new Request(`https://example.test/upload?access=private&uploadNameType=origin&uploadFolder=cloudreve-test/1&storageUploadId=op-${size}`, { method: 'POST', headers, body: form }), object));
        };
        const result = await send(); assert.equal(result.status, 200, await result.clone().text());
        assert.deepEqual((await result.json())[0], { src: `/file/${object}`, access: 'private', storageUploadId: `op-${size}` });
        assert.equal(records.get(object).metadata.Access, 'private');
        const uploads = files.size;
        assert.equal((await send()).status, 200); assert.equal(files.size, uploads, 'retry must not upload again');
        const get = (method = 'GET', extra = {}, auth = true) => read(context(new Request(`https://example.test/file/${object}?from=admin`, { method, headers: { ...(auth ? headers : {}), ...extra } }), object));
        const head = await get('HEAD');
        assert.equal(head.headers.get('Content-Length'), String(size));
        assert.equal(head.headers.get('X-Imagebed-Upload-Id'), `op-${size}`);
        assert.match(head.headers.get('Cache-Control'), /no-store/);
        assert.equal((await get('GET', {}, false)).status, 401);
        const full = await get(); assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
        for (const [range, start, end] of [['bytes=2-4', 2, 4], ['bytes=-3', size - 3, size - 1], [`bytes=${size - 9 > 0 ? size - 9 : 0}-`, Math.max(0, size - 9), size - 1]]) {
            const part = await get('GET', { Range: range }); assert.equal(part.status, 206);
            assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bytes.slice(start, end + 1));
            assert.equal(part.headers.get('Content-Range'), `bytes ${start}-${end}/${size}`);
        }
        const invalid = await get('GET', { Range: `bytes=${size}-` }); assert.equal(invalid.status, 416);
        assert.equal(invalid.headers.get('Content-Range'), `bytes */${size}`);
        assert.equal(await deleteFile(env, object, `https://example.test/file/${object}`, new URL('https://example.test/')), true);
        assert.equal((await get()).status, 404);
    }
    await Promise.all(tasks);
});

test('server-side routing honors configured defaults and never silently changes an invalid target', async t => {
    const { preparePrivateUpload } = await import('../../../functions/upload/privateUpload.js');
    let chat = { type: 'channel' };
    t.mock.method(TelegramAPI.prototype, 'getChat', async () => chat);
    const context = (name = '', enabled = true) => ({
        url: new URL('https://example.test/upload?access=private&storageUploadId=stable'),
        env: { img_url: { async get() { return JSON.stringify({ config: [{ id: 'defaultUploadChannel', value: 'telegram' }, { id: 'defaultChannelName', value: name }] }); } } },
        uploadConfig: { telegram: { channels: [{ name: 'existing-tg', enabled }] } },
    });
    const c = context(); assert.equal(await preparePrivateUpload(c, async () => true), null);
    assert.equal(c.url.searchParams.get('channelName'), 'existing-tg');
    assert.equal((await preparePrivateUpload(context('missing'), async () => true)).status, 400);
    assert.equal((await preparePrivateUpload(context('', false), async () => true)).status, 400);
    const broken = context(); broken.env.img_url.get = async () => { throw new Error('database unavailable'); };
    assert.equal((await preparePrivateUpload(broken, async () => true)).status, 503);
    chat = { type: 'channel', username: 'public-channel' };
    assert.equal((await preparePrivateUpload(context(), async () => true)).status, 403);
    chat = { type: 'supergroup', active_usernames: ['public-group'] };
    assert.equal((await preparePrivateUpload(context(), async () => true)).status, 403);
    chat = { type: 'private', username: 'private-user' };
    assert.equal(await preparePrivateUpload(context(), async () => true), null, 'a user handle does not make a private chat public');
});

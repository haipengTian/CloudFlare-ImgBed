import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest as upload } from '../../../functions/upload/index.js';
import { onRequest as read } from '../../../functions/file/[[path]].js';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

test('real ImageBed R2 handler: atomic private upload, HEAD size, authenticated Range, anonymous denial', async () => {
    globalThis.caches = { default: { async put() {} } };
    const records = new Map();
    const objects = new Map();
    const tasks = [];
    const token = 'synthetic-private-storage-token';
    records.set('manage@sysConfig@security', { value: JSON.stringify({ apiTokens: { tokens: { trial: { token, permissions: ['upload', 'manage', 'delete'] } } } }) });
    const env = {
        IMGBED_PRIVATE_STORAGE_CHANNELS: 'cfr2:R2_env',
        img_url: {
            async get(key) { return records.get(key)?.value ?? null; },
            async getWithMetadata(key) { return records.get(key) ?? { value: null, metadata: null }; },
            async put(key, value, options) { records.set(key, { value, metadata: structuredClone(options?.metadata) }); },
            async delete(key) { records.delete(key); },
            async list() { return { keys: [], list_complete: true }; },
        },
        img_r2: {
            async put(key, file) { objects.set(key, new Uint8Array(await file.arrayBuffer())); },
            async get(key, options) {
                const bytes = objects.get(key); if (!bytes) return null;
                const offset = options?.range?.offset ?? 0;
                const length = options?.range?.length ?? bytes.length - offset;
                return { size: bytes.length, writeHttpMetadata() {}, body: bytes.slice(offset, offset + length), range: options?.range ? { offset, length } : undefined };
            },
        },
    };
    const context = request => ({ request, env, params: { path: 'cloudreve-test/1/unique.txt' }, waitUntil(promise) { tasks.push(promise.catch(() => {})); } });
    const form = new FormData(); form.set('file', new Blob(['abcdef'], { type: 'text/plain' }), 'unique.txt');
    const result = await upload(context(new Request('https://example.test/upload?access=private&uploadChannel=cfr2&channelName=R2_env&uploadFolder=cloudreve-test/1&uploadNameType=origin&storageUploadId=synthetic-operation', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })));
    assert.equal(result.status, 200);
    assert.equal((await result.json())[0].access, 'private');
    const record = records.get('cloudreve-test/1/unique.txt');
    assert.equal(record.metadata.Access, 'private');
    const retryForm = new FormData(); retryForm.set('file', new Blob(['abcdef'], { type: 'text/plain' }), 'unique.txt');
    const retry = await upload(context(new Request('https://example.test/upload?access=private&uploadChannel=cfr2&channelName=R2_env&uploadFolder=cloudreve-test/1&uploadNameType=origin&storageUploadId=synthetic-operation', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: retryForm })));
    assert.equal((await retry.json())[0].src, '/file/cloudreve-test/1/unique.txt', 'private retry must not auto-rename into an orphan');
    assert.equal(objects.size, 1);
    const headers = { Authorization: `Bearer ${token}` };
    const head = await read(context(new Request('https://example.test/file/cloudreve-test/1/unique.txt?from=admin', { method: 'HEAD', headers })));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('Content-Length'), '6');
    assert.equal(head.headers.get('X-Imagebed-Upload-Id'), 'synthetic-operation');
    const range = await read(context(new Request('https://example.test/file/cloudreve-test/1/unique.txt?from=admin', { headers: { ...headers, Range: 'bytes=2-4' } })));
    assert.equal(range.status, 206); assert.equal(await range.text(), 'cde');
    for (const query of ['', '?from=admin']) {
        const denied = await read(context(new Request(`https://example.test/file/cloudreve-test/1/unique.txt${query}`)));
        assert.equal(denied.status, 401, 'missing actual credentials must be denied even when legacy admin auth is unconfigured');
    }
    await Promise.all(tasks);
});

test('private S3 HEAD bypasses public CDN and uses the bucket HEAD response', async (t) => {
    const token = 'synthetic-s3-token';
    const metadata = { Access: 'private', StorageUploadId: 's3-operation', Channel: 'S3', ChannelName: 'S3_env', S3FileKey: 'cloudreve-test/unique.txt', FileType: 'text/plain', FileName: 'unique.txt' };
    const env = {
        S3_ACCESS_KEY_ID: 'synthetic-ak', S3_SECRET_ACCESS_KEY: 'synthetic-sk', S3_BUCKET_NAME: 'private-bucket', S3_ENDPOINT: 'https://s3.example.test', S3_CDN_DOMAIN: 'https://cdn.example.test',
        img_url: {
            async get(key) { return key === 'manage@sysConfig@security' ? JSON.stringify({ apiTokens: { tokens: { trial: { token, permissions: ['manage'] } } } }) : null; },
            async getWithMetadata() { return { value: '', metadata }; },
        },
    };
    let calls = 0;
    t.mock.method(S3Client.prototype, 'send', async command => {
        calls++;
        assert.ok(command instanceof HeadObjectCommand, 'HEAD must not download or leak a GET body');
        assert.equal(command.input.Bucket, 'private-bucket');
        return { ContentLength: 6 };
    });
    const response = await read({ env, params: { path: 'cloudreve-test/unique.txt' }, request: new Request('https://example.test/file/cloudreve-test/unique.txt?from=admin', { method: 'HEAD', headers: { Authorization: `Bearer ${token}` } }) });
    assert.equal(calls, 1);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Length'), '6');
});

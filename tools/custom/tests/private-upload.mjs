import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';

test('private uploads are authorized and private before storage, ordinary uploads retain their contract', async () => {
    const moduleUrl = new URL('../../../functions/upload/privateUpload.js', import.meta.url);
    assert.ok(existsSync(moduleUrl), 'private upload contract must exist');
    const { preparePrivateUpload, uploadAccessMetadata, uploadAccessResponse } = await import(moduleUrl);
    const seen = [];
    const authorized = async permission => { seen.push(permission); return true; };
    const context = { request: new Request('https://example.test/upload?access=private&uploadChannel=s3&channelName=private&storageUploadId=operation'), url: new URL('https://example.test/upload?access=private&uploadChannel=s3&channelName=private&storageUploadId=operation'), env: { IMGBED_PRIVATE_STORAGE_CHANNELS: 's3:private' }, uploadConfig: { s3: { channels: [{ name: 'private' }] } } };
    assert.equal(await preparePrivateUpload(context, authorized), null);
    assert.deepEqual(seen, ['upload', 'manage']);
    assert.deepEqual(uploadAccessMetadata(context), { Access: 'private', ListType: 'Block', StorageUploadId: 'operation' });
    assert.deepEqual(uploadAccessResponse(context), { access: 'private', storageUploadId: 'operation' });
    const publicContext = { url: new URL('https://example.test/upload') };
    assert.equal(await preparePrivateUpload(publicContext, () => { throw new Error('new checks must not affect existing uploads'); }), null);
    assert.deepEqual(uploadAccessMetadata(publicContext), {});
    assert.deepEqual(uploadAccessResponse(publicContext), {});
    for (const deniedPermission of ['upload', 'manage']) {
        const denied = await preparePrivateUpload({ ...context }, async permission => permission !== deniedPermission);
        assert.equal(denied.status, 403);
    }
    for (const query of ['chunked=true', 'initChunked=true', 'cleanup=true']) {
        const denied = await preparePrivateUpload({ url: new URL(`https://example.test/upload?access=private&${query}`) }, authorized);
        assert.equal(denied.status, 400, 'private semantics must not silently downgrade on a different upload path');
    }
    for (const patch of [
        { env: {} },
        { uploadConfig: { s3: { channels: [] } } },
        { uploadConfig: { s3: { channels: [{ name: 'private', cdnDomain: 'https://public.example.test' }] } } },
    ]) {
        const denied = await preparePrivateUpload({ ...context, ...patch }, authorized);
        assert.ok(denied instanceof Response && denied.status >= 400, 'private storage must reject missing opt-in, missing channel and known public endpoints');
    }
});

test('private file reads require authenticated admin preview even if someone changes the block label', async () => {
    const { returnWithCheck } = await import('../../../functions/file/fileTools.js');
    const record = { metadata: { Access: 'private', ListType: 'White' } };
    for (const fileAccess of [{}, { isAdminPreview: true, adminAuthResult: { authorized: false } }, { isAdminPreview: true, adminAuthResult: { authorized: true } }]) {
        const result = await returnWithCheck({ url: new URL('https://example.test/file/private.txt'), securityConfig: { access: { whiteListMode: false } }, fileAccess }, record);
        assert.equal(result.status, 401, 'anonymous direct link must not expose the private object');
        assert.match(result.headers.get('Cache-Control'), /no-store/);
    }
    const context = { url: new URL('https://example.test/file/private.txt?from=admin'), securityConfig: { access: { whiteListMode: false } }, fileAccess: { isAdminPreview: true, privateAuthorized: true, adminAuthResult: { authorized: true } } };
    assert.equal((await returnWithCheck(context, record)).status, 200);
    assert.match(context.fileAccess.cacheControl, /private/);
});

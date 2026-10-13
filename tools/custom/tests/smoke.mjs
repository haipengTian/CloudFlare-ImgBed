// 对正在运行的隔离实例验收。凭据仅来自环境变量，记录文件只保存测试文件路径。
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const [base, recordPath, mode = 'upload'] = process.argv.slice(2);
assert.ok(base && recordPath, 'Usage: node smoke.mjs <base URL> <record path> [upload|verify]');
assert.ok(['upload', 'verify'].includes(mode), 'Invalid smoke mode');
const origin = new URL(base).origin;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function request(path, options = {}) {
    return fetch(new URL(path, origin), { ...options, signal: AbortSignal.timeout(15000) });
}
async function expectStatus(path, expected, options) {
    const response = await request(path, options);
    assert.equal(response.status, expected, `${path} status`);
    await response.body?.cancel();
}
await expectStatus('/', 200);
await expectStatus('/api/manage/list', 401);
await expectStatus('/upload', 401, { method: 'POST' });
const jsonHeaders = { 'Content-Type': 'application/json' };
await expectStatus('/api/auth/adminLogin', 401, {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ username: process.env.BASIC_USER, password: 'deliberately-wrong-smoke-password' }),
});
assert.ok(process.env.BASIC_USER && process.env.BASIC_PASS && process.env.AUTH_CODE, 'Synthetic smoke credentials must be set');
const login = await request('/api/auth/adminLogin', {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ username: process.env.BASIC_USER, password: process.env.BASIC_PASS }),
});
assert.equal(login.status, 200, 'admin login');
const cookie = login.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie, 'admin session cookie');
assert.equal((await login.json()).success, true, 'admin login business response');
await expectStatus('/api/manage/sysConfig/security', 200, { headers: { Cookie: cookie } });

let src;
if (mode === 'upload') {
    const form = new FormData();
    form.set('file', new Blob([png], { type: 'image/png' }), 'custom-deployment-smoke.png');
    const upload = await request('/upload?uploadChannel=cfr2&autoRetry=false', {
        method: 'POST', headers: { authCode: process.env.AUTH_CODE }, body: form,
    });
    assert.equal(upload.status, 200, 'local object upload');
    const result = await upload.json();
    src = result[0]?.src;
    assert.ok(typeof src === 'string', 'upload returned a file link');
    const url = new URL(src, origin);
    assert.equal(url.origin, origin, 'smoke file must remain on the isolated instance');
    assert.ok(url.pathname.startsWith('/file/'), 'upload returned a file route');
    src = url.pathname;
    await writeFile(recordPath, JSON.stringify({ src }), { mode: 0o600 });
} else {
    ({ src } = JSON.parse(await readFile(recordPath, 'utf8')));
    assert.ok(src.startsWith('/file/') && !src.includes('..'), 'valid recorded file');
}
const content = await request(src, { headers: { Cookie: cookie } });
assert.equal(content.status, 200, 'file read');
assert.deepEqual(Buffer.from(await content.arrayBuffer()), png, 'uploaded bytes are preserved');

if (mode === 'verify') {
    const fileId = src.slice('/file/'.length);
    const deletion = await request(`/api/manage/delete/${fileId}`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(deletion.status, 200, 'file deletion');
    const result = await deletion.json();
    assert.equal(result.success, true, 'file deletion business response');
    await expectStatus(src, 404, { headers: { Cookie: cookie } });
}
console.log(`PASS: ${mode === 'upload' ? 'authentication, upload and exact file bytes' : 'restart persistence, authentication and deletion'}`);

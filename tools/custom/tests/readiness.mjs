import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';

const moduleUrl = new URL('../../../deploy/server/readiness.js', import.meta.url);
test('Docker readiness validates effective persisted authentication', async () => {
    assert.ok(existsSync(moduleUrl), 'Docker readiness must reject weak persisted authentication');
    const { checkReadiness } = await import(moduleUrl);
    function env(settings) {
        return {
            BASIC_USER: 'admin', BASIC_PASS: 'initial-password', AUTH_CODE: 'initial-user-password',
            img_url: { async get() { return settings === undefined ? null : JSON.stringify(settings); } },
        };
    }
    assert.equal(await checkReadiness(env()), true, 'initial environment authentication is ready');
    assert.equal(await checkReadiness(env({ auth: { admin: { adminUsername: 'admin', adminPassword: '' } } })), false, 'username-only admin must be blocked');
    assert.equal(await checkReadiness(env({ auth: { user: { authCode: '' } } })), false, 'anonymous upload must be blocked');
    assert.equal(await checkReadiness(env({ auth: { admin: { adminPassword: 'persisted-new-password' }, user: { authCode: 'persisted-user-password' } } })), true, 'persistent passwords take precedence');
    const unavailable = env();
    unavailable.img_url.get = async () => { throw new Error('synthetic database unavailable'); };
    assert.equal(await checkReadiness(unavailable), false, 'database failure must be blocked');
});

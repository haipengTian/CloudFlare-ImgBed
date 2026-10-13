// Docker 部署就绪检查：使用实际生效的安全设置，不能只检查初始环境变量。
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../../functions/utils/databaseAdapter.js';
import { getSecurityConfig } from '../../functions/api/manage/sysConfig/security.js';

export async function checkReadiness(env) {
    try {
        const settings = await getSecurityConfig(getDatabase(env), env);
        return typeof settings.auth.admin.adminPassword === 'string'
            && settings.auth.admin.adminPassword.trim().length > 0
            && typeof settings.auth.user.authCode === 'string'
            && settings.auth.user.authCode.trim().length > 0;
    } catch {
        return false;
    }
}

async function main() {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const dbPath = join(root, 'data', 'database.sqlite');
    if (!existsSync(dbPath)) throw new Error('Database not initialized');
    const { SqliteD1 } = await import('./sqliteD1.js');
    const sqlite = new SqliteD1(dbPath);
    try {
        const env = { ...process.env, img_d1: sqlite };
        if (!await checkReadiness(env)) throw new Error('Effective admin and upload passwords are required');
        const settings = await getSecurityConfig(getDatabase(env), env);
        const base = process.argv[2] || `http://127.0.0.1:${process.env.PORT || '8080'}`;
        const cases = [
            ['/', 'GET', 200],
            ['/api/manage/list', 'GET', 401],
            ['/upload', 'POST', 401],
            ['/api/auth/adminLogin', 'POST', 401],
        ];
        for (const [path, method, expected] of cases) {
            const options = { method, signal: AbortSignal.timeout(5000) };
            if (path === '/api/auth/adminLogin') {
                options.headers = { 'Content-Type': 'application/json' };
                options.body = JSON.stringify({ username: settings.auth.admin.adminUsername, password: `readiness-invalid-${randomUUID()}` });
            }
            const response = await fetch(new URL(path, base), options);
            await response.body?.cancel();
            if (response.status !== expected) throw new Error('HTTP authentication check failed');
        }
    } finally {
        sqlite.db.close();
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(() => console.log('Readiness check passed')).catch(() => {
        // 不打印数据库设置、响应正文或凭据。
        console.error('Readiness check failed: inspect application state and effective authentication settings');
        process.exitCode = 1;
    });
}

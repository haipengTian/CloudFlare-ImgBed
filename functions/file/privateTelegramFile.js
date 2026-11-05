import { TelegramAPI } from '../utils/storage/telegramAPI.js';
import { resolveTelegramCredentials } from '../utils/metadata/channelCredentials.js';
import { getDatabase } from '../utils/databaseAdapter.js';

// Uniform private content semantics, independent of Telegram's own HTTP Range
// support. At most one <=16 MiB Telegram document is buffered per stream pull.
export async function privateTelegramFile(context, record, encodedName, fileType) {
    const { request, env } = context;
    const metadata = record.metadata;
    let chunks;
    try {
        chunks = metadata.IsChunked ? JSON.parse(record.value) : [{ fileId: metadata.TgFileId, size: metadata.FileSizeBytes }];
        if (!Array.isArray(chunks) || !chunks.length ||
            (metadata.IsChunked && chunks.length !== metadata.TotalChunks) ||
            chunks.some(c => !c.fileId || !Number.isSafeInteger(c.size) || c.size < 0)) throw new Error();
        if (metadata.IsChunked) {
            chunks.sort((a, b) => a.index - b.index);
            if (chunks.some((c, i) => c.index !== i)) throw new Error();
        }
    } catch {
        return new Response('Invalid private file metadata', { status: 500 });
    }
    const total = chunks.reduce((sum, c) => sum + c.size, 0);
    if (!Number.isSafeInteger(total) || total !== metadata.FileSizeBytes) {
        return new Response('Private file size metadata mismatch', { status: 500 });
    }
    const etag = `"${metadata.StorageUploadId}-${total}"`;
    const headers = new Headers({
        'Content-Type': fileType || 'application/octet-stream',
        'Content-Disposition': `inline; filename*=UTF-8''${encodedName}`,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', ETag: etag,
        'Content-Length': String(total),
    });
    if (request.headers.get('If-Match') && !['*', etag].includes(request.headers.get('If-Match'))) {
        return new Response(null, { status: 412, headers: { 'Cache-Control': 'no-store' } });
    }
    if (request.headers.get('If-None-Match')?.split(',').some(v => ['*', etag, `W/${etag}`].includes(v.trim()))) {
        return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'private, no-store' } });
    }
    // Per HTTP, Range applies only to GET; HEAD describes the complete object.
    if (request.method === 'HEAD') return new Response(null, { headers });
    let start = 0, end = total - 1, status = 200;
    const range = request.headers.get('Range');
    if (range && (!request.headers.get('If-Range') || request.headers.get('If-Range') === etag)) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
            return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}`, 'Cache-Control': 'no-store' } });
        }
        start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total || (!match[1] && Number(match[2]) === 0)) {
            return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}`, 'Cache-Control': 'no-store' } });
        }
        status = 206;
        headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
        headers.set('Content-Length', String(end - start + 1));
    }
    if (total === 0) return new Response(null, { headers });
    const credentials = await resolveTelegramCredentials(getDatabase(env), env, metadata);
    const api = new TelegramAPI(credentials.botToken, credentials.proxyUrl || '');
    let offset = 0;
    const selected = chunks.map(c => { const part = { ...c, offset }; offset += c.size; return part; })
        .filter(c => c.offset <= end && c.offset + c.size > start);
    let index = 0, canceled = false;
    const body = new ReadableStream({
        async pull(controller) {
            if (index >= selected.length) { controller.close(); return; }
            const chunk = selected[index++];
            try {
                const response = await api.getFileContent(chunk.fileId);
                if (!response.ok) throw new Error();
                const bytes = new Uint8Array(await response.arrayBuffer());
                if (bytes.length !== chunk.size) throw new Error();
                if (!canceled) controller.enqueue(bytes.subarray(Math.max(0, start - chunk.offset), Math.min(chunk.size, end - chunk.offset + 1)));
            } catch {
                if (!canceled) controller.error(new Error('ImageBed could not read the private Telegram document'));
            }
        },
        cancel() { canceled = true; },
    }, { highWaterMark: 0 });
    return new Response(body, { status, headers });
}

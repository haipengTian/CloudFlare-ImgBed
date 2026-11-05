import { getPageConfig } from '../api/manage/sysConfig/page.js';
import { getDatabase } from '../utils/databaseAdapter.js';
import { TelegramAPI } from '../utils/storage/telegramAPI.js';
import { selectConsistentChannel } from './uploadTools.js';

// Reuse ImageBed's existing defaults; clients need not know the storage backend.
export async function resolvePrivateChannel(context) {
    let type = context.url.searchParams.get('uploadChannel');
    let name = context.url.searchParams.get('channelName');
    if (!type) {
        let page;
        try {
            page = await getPageConfig(getDatabase(context.env), context.env);
        } catch {
            return new Response('ImageBed could not read its default storage settings', { status: 503 });
        }
        type = page.config?.find(c => c.id === 'defaultUploadChannel')?.value || 'telegram';
        name = page.config?.find(c => c.id === 'defaultChannelName')?.value || '';
    }
    if (!['telegram', 's3', 'cfr2'].includes(type)) {
        return new Response('The ImageBed default channel does not support private storage', { status: 400 });
    }
    const settings = context.uploadConfig?.[type];
    const channels = (settings?.channels || []).filter(c => c.enabled !== false);
    const channel = name ? channels.find(c => c.name === name) :
        selectConsistentChannel(channels, context.url.searchParams.get('storageUploadId'), settings?.loadBalance?.enabled);
    if (!channel) {
        return new Response('ImageBed default storage channel is missing, disabled or full', { status: 400 });
    }
    if (type === 'telegram') {
        // A public chat would publish the document outside the authenticated API.
        try {
            const chat = await new TelegramAPI(channel.botToken, channel.proxyUrl || '').getChat(channel.chatId);
            if (!chat || !['private', 'group', 'supergroup', 'channel'].includes(chat.type) || chat.username || chat.active_usernames?.length) {
                return new Response('Private storage requires a non-public Telegram chat', { status: 403 });
            }
        } catch {
            return new Response('ImageBed could not verify the Telegram storage chat', { status: 502 });
        }
    } else {
        const allowed = String(context.env?.IMGBED_PRIVATE_STORAGE_CHANNELS || '').split(',').map(s => s.trim());
        if (!allowed.includes(`${type}:${channel.name}`) || channel.publicUrl || channel.cdnDomain) {
            return new Response('ImageBed storage channel is not configured for private storage', { status: 403 });
        }
    }
    context.url.searchParams.set('uploadChannel', type);
    context.url.searchParams.set('channelName', channel.name);
    return null;
}

// Opt-in contract for server-side storage clients. Existing upload requests are unchanged.
export async function preparePrivateUpload(context, hasTokenPermission) {
    if (context.url.searchParams.get('access') !== 'private') return null;
    for (const flag of ['chunked', 'initChunked', 'cleanup', 'merge']) {
        if (context.url.searchParams.get(flag) === 'true') {
            return new Response('Private upload currently requires a single multipart request', { status: 400 });
        }
    }
    const uploadId = context.url.searchParams.get('storageUploadId');
    if (!uploadId || !/^[a-zA-Z0-9_-]{1,128}$/.test(uploadId)) {
        return new Response('Private storage upload requires a stable storageUploadId', { status: 400 });
    }
    // API tokens only: anonymous upload/authCode must never grant private-storage access.
    for (const permission of ['upload', 'manage']) {
        if (!await hasTokenPermission(permission)) {
            return new Response('Private upload requires upload and manage API token permissions', { status: 403 });
        }
    }
    const routingError = await resolvePrivateChannel(context);
    if (routingError) return routingError;
    context.privateUpload = true;
    return null;
}

export function uploadAccessMetadata(context) {
    // Set before the first object/metadata write. Block also excludes it from the public gallery.
    return context.privateUpload ? { Access: 'private', ListType: 'Block', StorageUploadId: context.url.searchParams.get('storageUploadId') } : {};
}

export function uploadAccessResponse(context) {
    return context.privateUpload ? { access: 'private', storageUploadId: context.url.searchParams.get('storageUploadId') } : {};
}

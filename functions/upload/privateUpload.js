// Opt-in contract for server-side storage clients. Existing upload requests are unchanged.
export async function preparePrivateUpload(context, hasTokenPermission) {
    if (context.url.searchParams.get('access') !== 'private') return null;
    for (const flag of ['chunked', 'initChunked', 'cleanup', 'merge']) {
        if (context.url.searchParams.get(flag) === 'true') {
            return new Response('Private upload currently requires a single multipart request', { status: 400 });
        }
    }
    if (!['s3', 'cfr2'].includes(context.url.searchParams.get('uploadChannel'))) {
        return new Response('Private upload currently supports s3 or cfr2 channels', { status: 400 });
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
    // Explicit opt-in applies only to this new usage. Never change the public
    // bucket/CDN settings used by existing image links.
    const type = context.url.searchParams.get('uploadChannel');
    const name = context.url.searchParams.get('channelName');
    const allowed = String(context.env?.IMGBED_PRIVATE_STORAGE_CHANNELS || '').split(',').map(s => s.trim());
    const channel = context.uploadConfig?.[type]?.channels?.find(c => c.name === name);
    if (!name || !channel) {
        return new Response('Private upload requires an exact enabled channelName; fallback is not allowed', { status: 400 });
    }
    if (!allowed.includes(`${type}:${name}`) || channel.publicUrl || channel.cdnDomain) {
        return new Response('Channel is not configured for private storage; use an opted-in non-public channel', { status: 403 });
    }
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

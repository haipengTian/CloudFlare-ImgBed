// The manage middleware authenticates this route. Clients check before writing,
// so an older deployment cannot silently accept a private request as public.
export function onRequest() {
    return Response.json({ version: 1, privateUpload: true });
}

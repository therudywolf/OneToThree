import { SESSION_COOKIE } from './session-cookie.js';
export async function getAuthUser(request) {
    const token = request.cookies[SESSION_COOKIE];
    if (!token)
        return null;
    try {
        const p = await request.server.jwt.verify(token);
        if (!p.sub || !p.username)
            return null;
        return { id: p.sub, username: p.username };
    }
    catch {
        return null;
    }
}

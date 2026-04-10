import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { chatMembers, messages } from '../db/schema.js';
import { getAuthUser } from '../lib/auth-user.js';
async function resolveWsUser(request) {
    const fromCookie = await getAuthUser(request);
    if (fromCookie)
        return fromCookie;
    const q = request.query;
    const ticket = q?.ticket?.trim();
    if (!ticket)
        return null;
    try {
        const p = await request.server.jwt.verify(ticket);
        if (p.scope !== 'ws' || !p.sub || !p.username)
            return null;
        return { id: p.sub, username: p.username };
    }
    catch {
        return null;
    }
}
import { sendPushToUser } from '../lib/push.js';
import { broadcastToUsers, hasActiveSocket, registerUserSocket, sendToUser, } from '../ws/registry.js';
const chatMessageInSchema = z.object({
    type: z.literal('chat_message'),
    chat_id: z.string().uuid(),
    content: z.string().nullable().optional(),
    iv: z.string().nullable().optional(),
    media_path: z.string().nullable().optional(),
    media_type: z.string().nullable().optional(),
    media_iv: z.string().nullable().optional(),
});
const webrtcSignalSchema = z.object({
    type: z.literal('webrtc_signal'),
    targetUserId: z.string().uuid(),
    signalData: z.unknown(),
});
function bufferToString(raw) {
    if (typeof raw === 'string')
        return raw;
    if (Buffer.isBuffer(raw))
        return raw.toString('utf8');
    if (raw instanceof ArrayBuffer) {
        return Buffer.from(raw).toString('utf8');
    }
    if (Array.isArray(raw)) {
        return Buffer.concat(raw.map((b) => Buffer.from(b))).toString('utf8');
    }
    return '';
}
export const wsRoutes = async (app) => {
    app.get('/ws', { websocket: true }, (ws, request) => {
        const pending = [];
        let authed = null;
        const handleMessage = (raw, user) => {
            void (async () => {
                let json;
                try {
                    json = JSON.parse(bufferToString(raw));
                }
                catch {
                    ws.send(JSON.stringify({ type: 'error', error: 'INVALID_JSON' }));
                    return;
                }
                const chatParsed = chatMessageInSchema.safeParse(json);
                if (chatParsed.success) {
                    const p = chatParsed.data;
                    const member = await db
                        .select({ one: chatMembers.userId })
                        .from(chatMembers)
                        .where(and(eq(chatMembers.chatId, p.chat_id), eq(chatMembers.userId, user.id)))
                        .limit(1);
                    if (!member.length) {
                        ws.send(JSON.stringify({ type: 'error', error: 'NOT_A_MEMBER' }));
                        return;
                    }
                    const [row] = await db
                        .insert(messages)
                        .values({
                        chatId: p.chat_id,
                        senderId: user.id,
                        content: p.content ?? null,
                        iv: p.iv ?? null,
                        mediaPath: p.media_path ?? null,
                        mediaType: p.media_type ?? null,
                        mediaIv: p.media_iv ?? null,
                    })
                        .returning({
                        id: messages.id,
                        chatId: messages.chatId,
                        senderId: messages.senderId,
                        content: messages.content,
                        iv: messages.iv,
                        mediaPath: messages.mediaPath,
                        mediaType: messages.mediaType,
                        mediaIv: messages.mediaIv,
                        createdAt: messages.createdAt,
                    });
                    if (!row) {
                        ws.send(JSON.stringify({ type: 'error', error: 'INSERT_FAILED' }));
                        return;
                    }
                    const memberRows = await db
                        .select({ userId: chatMembers.userId })
                        .from(chatMembers)
                        .where(eq(chatMembers.chatId, p.chat_id));
                    const ids = memberRows.map((m) => m.userId);
                    const createdAt = row.createdAt instanceof Date
                        ? row.createdAt.toISOString()
                        : String(row.createdAt);
                    broadcastToUsers(ids, {
                        type: 'chat_message',
                        message: {
                            id: row.id,
                            chat_id: row.chatId,
                            sender_id: row.senderId,
                            content: row.content,
                            iv: row.iv,
                            media_path: row.mediaPath,
                            media_type: row.mediaType,
                            media_iv: row.mediaIv,
                            created_at: createdAt,
                        },
                    });
                    for (const memberId of new Set(ids)) {
                        if (memberId === user.id)
                            continue;
                        if (!hasActiveSocket(memberId)) {
                            void sendPushToUser(memberId, {
                                title: 'Новое сообщение',
                                body: 'Вам пришло зашифрованное сообщение',
                                url: `/?chat=${p.chat_id}`,
                                icon: '/wolf-logo.png',
                            });
                        }
                    }
                    return;
                }
                const rtcParsed = webrtcSignalSchema.safeParse(json);
                if (rtcParsed.success) {
                    const { targetUserId, signalData } = rtcParsed.data;
                    sendToUser(targetUserId, {
                        type: 'webrtc_signal',
                        fromUserId: user.id,
                        signalData,
                    });
                    return;
                }
                ws.send(JSON.stringify({ type: 'error', error: 'UNKNOWN_MESSAGE_TYPE' }));
            })();
        };
        ws.on('message', (raw) => {
            if (!authed) {
                pending.push(raw);
                return;
            }
            handleMessage(raw, authed);
        });
        void resolveWsUser(request).then((user) => {
            if (!user) {
                ws.close(1008, 'unauthorized');
                return;
            }
            authed = user;
            registerUserSocket(user.id, ws);
            for (const raw of pending) {
                handleMessage(raw, user);
            }
            pending.length = 0;
        });
    });
};

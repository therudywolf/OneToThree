/** username → pending ECDSA challenge (memory-only; single-node) */
export const pendingChallenges = new Map();
const TTL_MS = 60_000;
export function setChallenge(username, nonce) {
    pruneExpired();
    pendingChallenges.set(username, {
        nonce,
        expiresAt: Date.now() + TTL_MS,
    });
}
export function getPending(username) {
    pruneExpired();
    const row = pendingChallenges.get(username);
    if (!row)
        return null;
    if (Date.now() > row.expiresAt) {
        pendingChallenges.delete(username);
        return null;
    }
    return row;
}
export function deletePending(username) {
    pendingChallenges.delete(username);
}
function pruneExpired() {
    const now = Date.now();
    for (const [u, row] of pendingChallenges) {
        if (now > row.expiresAt)
            pendingChallenges.delete(u);
    }
}

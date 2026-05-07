Set-Location "C:\Users\rudywolf\Workspace\OneToThree"

if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }

git add -A

git commit -m "feat: batch2 — msg edit, @mentions, drafts, spoilers, security fixes

Security (P0):
- livekit-e2ee-worker.js: remove console.log('encrypted payload') leak (IV+ciphertext exposed to DevTools)
- server/app.ts: remove 'unsafe-inline' from CSP scriptSrc (kept only for styleSrc as Tailwind requires it)
- app-security.test.ts: add assertion that scriptSrc no longer contains unsafe-inline

Message editing (B1):
- server/db/schema.ts + migration 0014: add edited_at column to messages
- server/routes/messages.ts: PATCH /:messageId — sender-only, re-encrypts fan-out slots or content+iv, broadcasts message_edited WS event
- client/lib/api/messages.ts: patchMessage() REST helper
- client/lib/fanout-crypto.ts: buildFanoutSlotsForEdit() for DIRECT chat edits
- client/store/chatStore.ts: updateMessagePlaintext() + type signature
- client/hooks/use-chat-realtime.ts: handle message_edited WS event
- client/components/chat/message-actions.tsx: un-hide Edit button (isMine && plaintext)
- client/components/chat/chat-input.tsx: submitEdit() uses patchMessage + re-encryption

@Mentions autocomplete (B2):
- client/components/chat/mentions-popover.tsx: floating popover with keyboard nav (arrows/Enter/Escape/Tab)
- client/components/chat/chat-input.tsx: parseMentionTrigger integration, lazy member fetch, @user insertion

Message drafts per-chat (B3):
- client/lib/chat-drafts.ts: saveDraft/loadDraft/clearDraft/hasDraft/getDraftChatIds + debounced save
- client/components/chat/chat-input.tsx: load draft on chat switch, debounced save on keystroke, clear on send

Spoiler text ||like this|| (B4):
- client/components/chat/noir-plaintext.tsx: SPOILER_RE + SpoilerSpan (blur/reveal on click) + processInlineText integration"

git push
Write-Host "DONE" -ForegroundColor Green

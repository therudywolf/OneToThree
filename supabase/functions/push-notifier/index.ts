/**
 * Supabase Edge Function: triggered by Database Webhook on INSERT into public.messages.
 * Sends Web Push to all chat members except the sender.
 *
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_SUBJECT, VAPID_PUBLIC_KEY,
 * VAPID_PRIVATE_KEY, SITE_URL, WEBHOOK_SECRET (optional; must match x-webhook-secret header).
 */

import { createClient } from 'npm:@supabase/supabase-js@2.45.0'
import webpush from 'npm:web-push@3.6.7'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-webhook-secret',
}

const subject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@localhost'
const pub = Deno.env.get('VAPID_PUBLIC_KEY')
const priv = Deno.env.get('VAPID_PRIVATE_KEY')
const siteUrl = (Deno.env.get('SITE_URL') ?? 'http://localhost:3000').replace(/\/$/, '')
const webhookSecret = Deno.env.get('WEBHOOK_SECRET')

if (pub && priv) {
  webpush.setVapidDetails(subject, pub, priv)
}

type WebhookBody = {
  type?: string
  table?: string
  schema?: string
  record?: {
    id?: string
    chat_id?: string
    sender_id?: string
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders })
  }

  if (webhookSecret) {
    const h = req.headers.get('x-webhook-secret')
    if (h !== webhookSecret) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
  }

  if (!pub || !priv) {
    return new Response(JSON.stringify({ error: 'VAPID keys not configured' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Supabase env missing' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let body: WebhookBody
  try {
    body = (await req.json()) as WebhookBody
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (body.table && body.table !== 'messages') {
    return new Response(JSON.stringify({ ok: true, skipped: 'table' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const record = body.record
  const chatId = record?.chat_id
  const senderId = record?.sender_id
  if (!chatId || !senderId) {
    return new Response(JSON.stringify({ ok: true, skipped: 'no record' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: members, error: memErr } = await supabase
    .from('chat_members')
    .select('user_id')
    .eq('chat_id', chatId)
    .neq('user_id', senderId)

  if (memErr) {
    return new Response(JSON.stringify({ error: memErr.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const userIds = (members ?? []).map((m: { user_id: string }) => m.user_id)
  if (userIds.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { data: subs, error: subErr } = await supabase
    .from('push_subscriptions')
    .select('user_id, subscription')
    .in('user_id', userIds)

  if (subErr) {
    return new Response(JSON.stringify({ error: subErr.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const payload = JSON.stringify({
    title: 'Forest Messenger',
    body: 'New encrypted message',
    icon: `${siteUrl}/wolf-logo.png`,
    data: { url: `${siteUrl}/?chat=${chatId}` },
  })

  let sent = 0
  const errors: string[] = []

  for (const row of subs ?? []) {
    const sub = row.subscription as {
      endpoint?: string
      keys?: { p256dh?: string; auth?: string }
    }
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) continue

    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys.p256dh,
            auth: sub.keys.auth,
          },
        },
        payload,
        { TTL: 120 }
      )
      sent++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(msg)
      if (msg.includes('410') || msg.includes('Gone')) {
        await supabase.from('push_subscriptions').delete().eq('user_id', row.user_id)
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, sent, errors: errors.slice(0, 5) }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})

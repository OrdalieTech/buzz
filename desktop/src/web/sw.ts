/// <reference lib="webworker" />
// Service worker for the browser build, bundled to /sw.js by vite.web.ts:
// authenticated relay media, notification taps, and push wakes.

import * as nip44 from "nostr-tools/nip44";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";

import {
  maxReadAt,
  msgContextKey,
} from "@/features/channels/readState/readStateFormat";
import {
  getThreadReference,
  isBroadcastReply,
} from "@/features/messages/lib/threading";
import {
  encoder,
  loadIdentity,
  type PushContext,
  type RelayEvent,
  readPushContext,
  writePushContext,
} from "./core";

declare const self: ServiceWorkerGlobalScope;

const ICON = "/app-icon@2x.png";
const MAX_SHOWN_PER_WAKE = 3;
// Lines kept in one channel's notification.
const MAX_LINES = 4;
// Wakes are only useful for an hour (the relay drops older ones too).
const LOOKBACK_SECONDS = 3600;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

// Any content-addressed relay blob: `/media/<sha256>`, optionally `.thumb`,
// optionally one extension.
const RELAY_MEDIA_PATH =
  /^\/media\/[\da-f]{64}(?:\.thumb)?(?:\.[\da-z]{1,10})?$/i;

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!RELAY_MEDIA_PATH.test(url.pathname)) return;
  if (event.request.method !== "GET" && event.request.method !== "HEAD") return;
  if (event.request.headers.has("Authorization")) return;
  event.respondWith(authenticatedMedia(event.request, event.clientId));
});

async function authenticatedMedia(request: Request, clientId: string) {
  const authorization = await requestMediaAuth(clientId);
  if (!authorization) return fetch(request);
  // Copying headers keeps Range (media seeking). A fresh cors-mode request is
  // required: <img>/<video> requests are no-cors, which silently drops
  // Authorization, and navigations cannot be re-wrapped with an init.
  const headers = new Headers(request.headers);
  headers.set("Authorization", authorization);
  return fetch(request.url, {
    method: request.method,
    headers,
    credentials: "omit",
    redirect: "error",
    signal: request.signal,
  });
}

async function requestMediaAuth(clientId: string) {
  for (const delayMs of [0, 150, 400, 800]) {
    if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
    const authorization = await requestMediaAuthOnce(clientId);
    if (authorization) return authorization;
  }
  return null;
}

async function requestMediaAuthOnce(clientId: string): Promise<string | null> {
  // Prefer the page that made the request; navigations (no clientId yet) and
  // worker-initiated requests fall back to any open window.
  const requester = clientId ? await self.clients.get(clientId) : undefined;
  const client =
    requester?.type === "window"
      ? requester
      : (
          await self.clients.matchAll({
            type: "window",
            includeUncontrolled: true,
          })
        )[0];
  if (!client) return null;
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      self.removeEventListener("message", onMessage);
      resolve(null);
    }, 2000);
    function onMessage(event: ExtendableMessageEvent) {
      if (event.data?.type !== "buzz-media-auth" || event.data?.id !== id)
        return;
      self.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(
        typeof event.data.authorization === "string"
          ? event.data.authorization
          : null,
      );
    }
    self.addEventListener("message", onMessage);
    client.postMessage({ type: "buzz-media-auth-request", id });
  });
}

// Focus (or open) the app and route it to the notified message.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.target ?? null;
  event.waitUntil(
    (async () => {
      const [client] = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // A cold start carries the target in the URL (see web/notifications.ts).
      if (!client) {
        await self.clients.openWindow(
          target
            ? `/?notification=${encodeURIComponent(JSON.stringify(target))}`
            : "/",
        );
        return;
      }
      const window = await client.focus();
      if (target)
        window.postMessage({ type: "buzz-notification-click", target });
    })(),
  );
});

// A push is a content-free wake from the relay (see web/push.ts). Fetch what
// woke us with the user's key and show it; browsers require a notification
// for every push, so fall back to a generic one when that is not possible.
self.addEventListener("push", (event) => event.waitUntil(showWake()));

// The open app asks for a sweep when it is shown or hidden (see
// NotificationPrompt.tsx). The wait lets its read state, published 5 s
// after the last read, reach the relay first.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "buzz-close-read") return;
  event.waitUntil(
    (async () => {
      await new Promise((done) => setTimeout(done, 6000));
      const context = await readPushContext();
      const key = context && (await loadIdentity());
      if (context && key) await closeRead(await readMarkers(context, key));
    })().catch((error) => console.warn("[sw] read sweep failed:", error)),
  );
});

async function showWake() {
  let handled = false;
  try {
    handled = await showNewMessages();
  } catch (error) {
    console.warn("[sw] push fetch failed:", error);
  }
  if (!handled)
    await self.registration.showNotification("Buzz", {
      body: "You have new messages",
      icon: ICON,
      tag: "buzz-wake",
    });
}

async function showNewMessages(): Promise<boolean> {
  const context = await readPushContext();
  const key = context && (await loadIdentity());
  if (!context || !key) return false;
  const now = Math.floor(Date.now() / 1000);
  const since = Math.max(context.lastSeen ?? 0, now - LOOKBACK_SECONDS);
  const [events, markers] = await Promise.all([
    query(
      context,
      key,
      context.filters.map((filter) => ({ ...filter, since, limit: 10 })),
    ),
    readMarkers(context, key),
  ]);
  const byId = new Map(
    events
      .filter((event) => event.pubkey !== context.pubkey && verifyEvent(event))
      .map((event) => [event.id, event]),
  );
  const newest = [...byId.values()].sort((a, b) => b.created_at - a.created_at);
  if (newest.length === 0) return false;
  await closeRead(markers);
  const notified = new Set(context.notified);
  const toShow = newest
    .filter((event) => !notified.has(event.id))
    .map(lineOf)
    .filter((line) => !isRead(markers, line))
    .slice(0, MAX_SHOWN_PER_WAKE);
  await writePushContext({
    ...context,
    lastSeen: Math.max(since, newest[0].created_at),
    notified: [...toShow.map((line) => line.id), ...notified].slice(0, 200),
  });
  if (toShow.length === 0) {
    // Already read on another device or already shown. Browsers still require
    // a notification for every push (iOS revokes the subscription after a
    // few silent ones), so show one quietly and take it straight back.
    await self.registration.showNotification("Buzz", {
      icon: ICON,
      silent: true,
      tag: "buzz-wake",
    });
    for (const notification of await self.registration.getNotifications({
      tag: "buzz-wake",
    }))
      notification.close();
    return true;
  }
  const names = await profileNames(
    context,
    key,
    toShow.map((line) => line.pubkey),
  );
  for (const line of toShow.reverse()) {
    const channel = line.channelId ? context.channels[line.channelId] : null;
    const sender = names.get(line.pubkey) ?? "Someone";
    const title =
      channel && !channel.dm && channel.name ? `#${channel.name}` : sender;
    const text = messagePreview(line.content);
    // One notification per channel: a new message joins its unread lines.
    const tag = line.channelId ?? line.id;
    const [previous] = await self.registration.getNotifications({ tag });
    const lines = [
      ...(previous?.data?.lines ?? []).filter(
        (old: Line) => !isRead(markers, old),
      ),
      { ...line, content: title === sender ? text : `${sender}: ${text}` },
    ].slice(-MAX_LINES);
    await self.registration.showNotification(title, {
      body: lines.map((entry) => entry.content).join("\n"),
      data: {
        target: { eventId: line.id, channelId: line.channelId },
        lines,
      },
      icon: ICON,
      renotify: true,
      tag,
      timestamp: line.createdAt * 1000,
    } as NotificationOptions);
  }
  return true;
}

type Line = {
  id: string;
  pubkey: string;
  content: string;
  channelId: string | null;
  rootId: string | null;
  createdAt: number;
};

function lineOf(event: RelayEvent): Line {
  return {
    id: event.id,
    pubkey: event.pubkey,
    content: event.content,
    channelId: event.tags.find((tag) => tag[0] === "h")?.[1] ?? null,
    rootId: isBroadcastReply(event.tags)
      ? null
      : getThreadReference(event.tags).rootId,
    createdAt: event.created_at,
  };
}

// Same rule as the app's unread badges (communityUnreadObserver.ts): read
// once the channel, its thread or the message itself is marked past it.
function isRead(markers: Map<string, number>, line: Line) {
  const readAt = maxReadAt(
    (line.channelId && markers.get(line.channelId)) || null,
    markers.get(msgContextKey(line.id)) ?? null,
    (line.rootId && markers.get(`thread:${line.rootId}`)) || null,
  );
  return readAt !== null && line.createdAt <= readAt;
}

// The user's read markers from every device: NIP-RS kind-30078 blobs
// encrypted to themselves, merged newest-wins. Unreadable means nothing read,
// so a failure here never hides a message.
async function readMarkers(context: PushContext, key: Uint8Array) {
  const events = await query(context, key, [
    {
      kinds: [30078],
      authors: [context.pubkey],
      "#t": ["read-state"],
      limit: 100,
    },
  ]).catch(() => []);
  const conversationKey = nip44.getConversationKey(key, context.pubkey);
  const markers = new Map<string, number>();
  for (const event of events)
    try {
      const { contexts } = JSON.parse(
        nip44.decrypt(event.content, conversationKey),
      );
      for (const [id, at] of Object.entries(contexts ?? {}))
        if (typeof at === "number" && at > (markers.get(id) ?? 0))
          markers.set(id, at);
    } catch {}
  return markers;
}

// Close the notifications whose every line has been read since.
async function closeRead(markers: Map<string, number>) {
  for (const notification of await self.registration.getNotifications()) {
    const lines: Line[] | undefined = notification.data?.lines;
    if (lines?.length && lines.every((line) => isRead(markers, line)))
      notification.close();
  }
}

async function profileNames(
  context: PushContext,
  key: Uint8Array,
  pubkeys: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const profiles = await query(context, key, [
      { kinds: [0], authors: [...new Set(pubkeys)] },
    ]);
    for (const profile of profiles.sort((a, b) => a.created_at - b.created_at))
      try {
        const { display_name, name } = JSON.parse(profile.content);
        if (display_name || name)
          names.set(profile.pubkey, display_name || name);
      } catch {}
  } catch {}
  return names;
}

function messagePreview(content: string) {
  const text = content
    .replace(/nostr:(npub1[\da-z]+|nprofile1[\da-z]+)/g, "@someone")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "Sent an attachment";
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

async function query(
  context: PushContext,
  key: Uint8Array,
  filters: Record<string, unknown>[],
): Promise<RelayEvent[]> {
  const url = `${context.relay}/query`;
  const body = JSON.stringify(filters);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(body));
  const auth = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["u", url],
        ["method", "POST"],
        [
          "payload",
          Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        ],
        ["nonce", crypto.randomUUID()],
      ],
    },
    key,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Nostr ${btoa(JSON.stringify(auth))}`,
      "Content-Type": "application/json",
    },
    body,
  });
  if (!response.ok) throw new Error(`query ${response.status}`);
  return response.json();
}

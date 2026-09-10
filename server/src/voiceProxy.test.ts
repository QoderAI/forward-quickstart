import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRealtimeUrl, createConnectionKeyStore, createVoiceProxy, isAllowedLocalOrigin, relayCloseCode } from './voiceProxy.js';

test('connection keys expire and are consumed once', () => {
  let now = 1_000;
  let serial = 0;
  const store = createConnectionKeyStore({ ttlMs: 30_000, now: () => now, randomKey: () => `key_${++serial}` });
  const payload = { pat: 'pat_secret', environment: 'cn-prod' as const, conversationId: 'conv_1' };
  const key = store.issue(payload);
  assert.equal(store.consume(key)?.conversationId, 'conv_1');
  assert.equal(store.consume(key), null);
  const expired = store.issue(payload);
  now += 30_001;
  assert.equal(store.consume(expired), null);
});

test('unconsumed connection keys are removed after their ttl', () => {
  let expire: (() => void) | undefined;
  const store = createConnectionKeyStore({
    ttlMs: 30_000,
    randomKey: () => 'key_unconsumed',
    scheduleExpiry: (callback) => { expire = callback; },
  });
  const key = store.issue({ pat: 'pat_secret', environment: 'cn-prod', conversationId: 'conv_1' });

  expire?.();

  assert.equal(store.consume(key), null);
});

test('builds CN and Global forward realtime urls', () => {
  assert.equal(buildRealtimeUrl('https://api.qoder.com.cn/api/v1/forward', 'conv a').toString(), 'wss://api.qoder.com.cn/api/v1/forward/realtime?conversation_id=conv+a');
  assert.equal(buildRealtimeUrl('https://api.qoder.com/api/v1/forward/', 'conv_2').toString(), 'wss://api.qoder.com/api/v1/forward/realtime?conversation_id=conv_2');
});

test('accepts loopback origins only', () => {
  assert.equal(isAllowedLocalOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedLocalOrigin('http://127.0.0.1:5173'), true);
  assert.equal(isAllowedLocalOrigin('https://attacker.example'), false);
  assert.equal(isAllowedLocalOrigin(undefined), false);
});

test('replaces reserved websocket close codes before relaying them', () => {
  assert.equal(relayCloseCode(1000, 1011), 1000);
  assert.equal(relayCloseCode(1001, 1011), 1001);
  assert.equal(relayCloseCode(1006, 1011), 1011);
  assert.equal(relayCloseCode(1015, 1000), 1000);
});

test('connection key endpoint rejects non-loopback browser origins', () => {
  const proxy = createVoiceProxy({
    baseUrls: {
      'cn-prod': 'https://api.qoder.com.cn/api/v1/forward',
      'global-prod': 'https://api.qoder.com/api/v1/forward',
    },
  });
  let status = 200;
  let response: unknown;
  const request = {
    headers: { origin: 'https://attacker.example' },
    body: { pat: 'pat_secret', environment: 'cn-prod', conversation_id: 'conv_1' },
  };
  const result = {
    status(value: number) { status = value; return this; },
    json(value: unknown) { response = value; return this; },
  };

  proxy.issueConnectionKey(request as never, result as never, () => undefined);

  assert.equal(status, 403);
  assert.deepEqual(response, { error: { message: 'Voice WebSocket proxy only accepts loopback browser origins' } });
});

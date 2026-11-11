const test = require('node:test');
const assert = require('node:assert');
const { NotificationManager, createNotifiers } = require('../src/notifiers');

function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const call = {
      url: String(url),
      method: opts.method,
      headers: opts.headers || {},
      body: opts.body ? JSON.parse(opts.body) : null,
    };
    calls.push(call);
    if (handler) return handler(call);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'ok', retcode: 0 }),
    };
  };
  return calls;
}

test('QQ adapter calls NapCat send_private_msg', async () => {
  const calls = mockFetch();
  const manager = new NotificationManager([
    {
      type: 'qq',
      enabled: true,
      url: 'http://napcat:3000/send_private_msg',
      user_id: '12345678',
    },
  ]);

  const result = await manager.sendAlert('DOWN: node-api', 'connection refused');

  assert.deepEqual(result, [{ type: 'qq', ok: true }]);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'http://napcat:3000/send_private_msg');
  assert.deepEqual(calls[0].body, {
    user_id: '12345678',
    message: [{ type: 'text', data: { text: 'DOWN: node-api\nconnection refused' } }],
  });
});

test('Telegram adapter uses bot API sendMessage', async () => {
  const calls = mockFetch();
  const manager = new NotificationManager([
    {
      type: 'telegram',
      enabled: true,
      bot_token: '123:ABC',
      chat_id: '-100123',
    },
  ]);

  await manager.sendAlert('RECOVERED: node-api', 'back online');

  assert.equal(calls[0].url, 'https://api.telegram.org/bot123:ABC/sendMessage');
  assert.deepEqual(calls[0].body, {
    chat_id: '-100123',
    text: 'RECOVERED: node-api\nback online',
    disable_web_page_preview: true,
  });
});

test('Discord adapter posts webhook content', async () => {
  const calls = mockFetch();
  const manager = new NotificationManager([
    {
      type: 'discord',
      enabled: true,
      webhook_url: 'https://discord.com/api/webhooks/1/secret',
    },
  ]);

  await manager.sendAlert('DOWN: genshinquiz-backend', 'health check failed');

  assert.equal(calls[0].url, 'https://discord.com/api/webhooks/1/secret');
  assert.deepEqual(calls[0].body, {
    content: 'DOWN: genshinquiz-backend\nhealth check failed',
  });
});

test('object config form and disabled notifiers are skipped', async () => {
  const calls = mockFetch();
  const manager = new NotificationManager({
    qq: { enabled: false, url: 'http://napcat:3000/send_private_msg', user_id: 1 },
    discord: { enabled: true, webhook_url: 'https://discord.com/api/webhooks/x' },
  });

  await manager.sendAlert('title', 'text');

  assert.equal(manager.notifiers.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://discord.com/api/webhooks/x');
});

test('notify() keeps the HealthMonitor message format', async () => {
  const calls = mockFetch();
  const manager = createNotifiers([
    { type: 'discord', enabled: true, webhook_url: 'https://discord.com/api/webhooks/x' },
  ]);

  await manager.notify({
    type: 'down',
    service: 'node-api',
    message: '🔴 node-api is DOWN: timeout',
    at: '2026-11-11T00:00:00.000Z',
  });

  assert.equal(calls[0].body.content, '🔴 node-api is DOWN: timeout');
});

test('a failing notifier does not block the others', async () => {
  mockFetch((call) => {
    if (call.url.includes('telegram')) {
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ message: 'boom' }),
      };
    }
    return {
      ok: true,
      status: 204,
      text: async () => '',
    };
  });
  const manager = new NotificationManager([
    { type: 'telegram', enabled: true, bot_token: 'x', chat_id: '1' },
    { type: 'discord', enabled: true, webhook_url: 'https://discord.com/api/webhooks/x' },
  ]);

  const result = await manager.sendAlert('title', 'text');

  assert.equal(result.filter((r) => r.ok).length, 1);
  assert.equal(result.filter((r) => !r.ok).length, 1);
});

test('$ENV placeholders are resolved and an unset enabled flag disables a channel', async () => {
  const calls = mockFetch();
  process.env.TEST_QQ_URL = 'http://napcat:3000/send_private_msg';
  delete process.env.TEST_QQ_ENABLED;

  const disabled = new NotificationManager([
    {
      type: 'qq',
      enabled: '$TEST_QQ_ENABLED',
      url: '$TEST_QQ_URL',
      user_id: '42',
    },
  ]);
  assert.equal(disabled.notifiers.length, 0);

  const enabledManager = new NotificationManager([
    {
      type: 'qq',
      enabled: true,
      url: '$TEST_QQ_URL',
      user_id: '42',
    },
  ]);
  delete process.env.TEST_QQ_URL;

  assert.equal(enabledManager.notifiers.length, 1);
  await enabledManager.sendAlert('title', 'text');
  assert.equal(calls[0].url, 'http://napcat:3000/send_private_msg');
  assert.deepEqual(calls[0].body.message, [{ type: 'text', data: { text: 'title\ntext' } }]);
});

test('missing required notifier options are skipped with a warning', () => {
  const manager = new NotificationManager([
    { type: 'telegram', enabled: true, chat_id: '1' },
    { type: 'qq', enabled: true, url: 'http://napcat:3000' },
  ]);
  assert.equal(manager.notifiers.length, 0);
});

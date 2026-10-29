// Notifier interface: { send(event) } where event = { type: 'down'|'recovered', service, message, at }
// Add a new BOT channel by adding a factory here and a config entry in gateway.config.json.

async function post(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`notifier HTTP ${res.status}`);
}

const json = { 'content-type': 'application/json' };

const factories = {
  log: () => ({ send: async (e) => console.log(`[notify] ${e.message}`) }),

  // Generic JSON webhook (works with most self-hosted bots)
  webhook: ({ url, headers }) => ({ send: (e) => post(url, { ...json, ...headers }, JSON.stringify(e)) }),

  telegram: ({ token, chatId }) => ({
    send: (e) => post(`https://api.telegram.org/bot${token}/sendMessage`, json, JSON.stringify({ chat_id: chatId, text: e.message })),
  }),

  discord: ({ url }) => ({ send: (e) => post(url, json, JSON.stringify({ content: e.message })) }),
};

// Secrets may be given as "$ENV_NAME" in config
const resolve = (v) => (typeof v === 'string' && v.startsWith('$') ? process.env[v.slice(1)] || '' : v);

function createNotifiers(configs = []) {
  const list = configs.map((c) => {
    const f = factories[c.type];
    if (!f) throw new Error(`unknown notifier type: ${c.type}`);
    const opts = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, resolve(v)]));
    return { type: c.type, ...f(opts) };
  });
  return {
    async notify(event) {
      await Promise.all(list.map((n) => n.send(event).catch((e) => console.error(`[notify:${n.type}] failed: ${e.message}`))));
    },
  };
}

module.exports = { createNotifiers };

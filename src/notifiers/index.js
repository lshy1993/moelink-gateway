// Unified notification manager for Guardian.
//
// Notifier interface:
//   class Notifier { async sendAlert(alert) { ... } }
//   alert = { type, service, title, text, message, at, ... }
//
// Add a new BOT channel by adding an adapter class and a factory entry below,
// then enable it in gateway.config.json (values may be "$ENV_NAME" references).

const json = { 'content-type': 'application/json' };

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const raw = await res.text().catch(() => '');
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    const detail = data && data.message ? `: ${data.message}` : '';
    throw new Error(`HTTP ${res.status}${detail}`);
  }
  return data;
}

function messageOf(alert = {}) {
  const title = alert.title ? String(alert.title).trim() : '';
  const text = alert.text ?? alert.message ?? '';
  return title && text ? `${title}\n${text}` : String(title || text);
}

function toList(value) {
  if (value === undefined || value === null || value === '') return [];
  const items = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))];
}

class Notifier {
  constructor({ type, enabled = true } = {}) {
    this.type = type || this.constructor.name;
    this.enabled = enabled !== false;
  }

  async sendAlert(_alert) {
    throw new Error(`${this.type}.sendAlert() is not implemented`);
  }

  // snake_case alias for integrations that prefer the Python-style name
  async send_alert(title, text) {
    return this.sendAlert({ title, text });
  }
}

class LogNotifier extends Notifier {
  async sendAlert(alert) {
    console.log(`[notify] ${messageOf(alert)}`);
  }
}

class WebhookNotifier extends Notifier {
  constructor(opts) {
    super(opts);
    this.url = opts.url;
    this.headers = opts.headers || {};
    if (!this.url) throw new Error('webhook notifier requires url');
  }

  async sendAlert(alert) {
    await postJson(this.url, { ...alert, message: messageOf(alert) }, this.headers);
  }
}

class TelegramNotifier extends Notifier {
  constructor(opts) {
    super(opts);
    this.token = opts.botToken || opts.bot_token || opts.token;
    this.chatId = opts.chatId ?? opts.chat_id;
    if (!this.token || this.chatId === undefined || this.chatId === '') {
      throw new Error('telegram notifier requires bot_token and chat_id');
    }
  }

  async sendAlert(alert) {
    const data = await postJson(
      `https://api.telegram.org/bot${this.token}/sendMessage`,
      {
        chat_id: this.chatId,
        text: messageOf(alert),
        disable_web_page_preview: true,
      },
    );
    if (data && data.ok === false) {
      throw new Error(`Telegram: ${data.description || 'request failed'}`);
    }
  }
}

class DiscordNotifier extends Notifier {
  constructor(opts) {
    super(opts);
    this.url = opts.webhookUrl || opts.webhook_url || opts.url;
    if (!this.url) throw new Error('discord notifier requires webhook_url');
  }

  async sendAlert(alert) {
    // Discord webhook content limit is 2000 characters
    await postJson(this.url, { content: messageOf(alert).slice(0, 2000) });
  }
}

class QQNotifier extends Notifier {
  constructor(opts) {
    super(opts);
    this.url = opts.url;
    const target = (value) =>
      value === undefined || value === null || value === '' ? null : value;
    this.userId = target(opts.userId ?? opts.user_id);
    this.groupIds = toList(
      opts.groupIds ?? opts.group_ids ?? opts.groupId ?? opts.group_id,
    );
    this.token = opts.token || opts.accessToken || opts.access_token;
    // NapCat / OneBot 11 支持字符串或消息段数组；默认使用 array
    this.messageFormat = String(
      opts.messageFormat || opts.message_format || 'array',
    ).toLowerCase();
    if (!this.url) throw new Error('qq notifier requires url');
    if (this.userId == null && this.groupIds.length === 0) {
      throw new Error('qq notifier requires user_id or group_id(s)');
    }
  }

  async sendOne(endpoint, target, message, headers) {
    const data = await postJson(endpoint, { ...target, message }, headers);
    if (data && data.status && data.status !== 'ok') {
      throw new Error(
        `${endpoint}: status=${data.status} retcode=${data.retcode ?? '?'}`,
      );
    }
    if (data && data.retcode !== undefined && data.retcode !== 0) {
      throw new Error(`${endpoint}: retcode=${data.retcode}`);
    }
  }

  async sendAlert(alert) {
    // 兼容 url 直接写到 /send_private_msg 或 /send_group_msg 的配置；
    // 同时配置 user_id 和 group_id 时，两边都发。
    const raw = this.url.replace(/\/$/, '');
    const base = raw.replace(/\/send_(private|group)_msg$/, '');
    const text = messageOf(alert);
    const message =
      this.messageFormat === 'string'
        ? text
        : [{ type: 'text', data: { text } }];
    const headers = this.token ? { authorization: `Bearer ${this.token}` } : {};

    const targets = [];
    if (this.userId != null) {
      targets.push({
        endpoint: `${base}/send_private_msg`,
        body: { user_id: this.userId },
      });
    }
    for (const groupId of this.groupIds) {
      targets.push({
        endpoint: `${base}/send_group_msg`,
        body: { group_id: groupId },
      });
    }

    const results = await Promise.allSettled(
      targets.map((t) => this.sendOne(t.endpoint, t.body, message, headers)),
    );
    const errors = results
      .filter((r) => r.status === 'rejected')
      .map((r) => r.reason.message);
    if (errors.length) throw new Error(errors.join('; '));
  }
}

const factories = {
  log: (opts) => new LogNotifier(opts),
  webhook: (opts) => new WebhookNotifier(opts),
  telegram: (opts) => new TelegramNotifier(opts),
  discord: (opts) => new DiscordNotifier(opts),
  qq: (opts) => new QQNotifier(opts),
  napcat: (opts) => new QQNotifier(opts),
};

// Secrets may be given as "$ENV_NAME" in config
function resolve(value) {
  return typeof value === 'string' && value.startsWith('$')
    ? process.env[value.slice(1)] ?? ''
    : value;
}

function enabled(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === null || value === '') return false;
  return !/^(false|0|no|off)$/i.test(String(value).trim());
}

// Supports both:
//   [{ type: "telegram", bot_token: "$TG_TOKEN", ... }]
// and the object form:
//   { qq: { enabled: true, ... }, telegram: { enabled: true, ... } }
function normalizeConfigs(configs) {
  if (Array.isArray(configs)) return configs;
  if (configs && typeof configs === 'object') {
    return Object.entries(configs).map(([type, opts]) => ({ type, ...(opts || {}) }));
  }
  return [];
}

class NotificationManager {
  constructor(configs = []) {
    this.notifiers = normalizeConfigs(configs)
      .map((config) => {
        const type = String(config.type || '').toLowerCase();
        const factory = factories[type];
        if (!factory) {
          console.error(`[notify] unknown notifier type: ${config.type}`);
          return null;
        }
        const opts = Object.fromEntries(
          Object.entries(config).map(([key, value]) => [key, resolve(value)]),
        );
        if (!enabled(opts.enabled, true)) return null;
        try {
          return factory({ ...opts, type });
        } catch (e) {
          console.error(`[notify:${type}] disabled: ${e.message}`);
          return null;
        }
      })
      .filter(Boolean);
  }

  async sendAlert(title, text, event = {}) {
    if (title && typeof title === 'object') {
      event = title;
      title = event.title || '';
      text = event.text ?? event.message ?? '';
    }
    const alert = {
      ...event,
      title: title || '',
      text: text ?? '',
      at: event.at || new Date().toISOString(),
    };
    alert.message = messageOf(alert);

    return Promise.all(
      this.notifiers.map(async (notifier) => {
        try {
          await notifier.sendAlert(alert);
          return { type: notifier.type, ok: true };
        } catch (e) {
          console.error(`[notify:${notifier.type}] failed: ${e.message}`);
          return { type: notifier.type, ok: false, error: e.message };
        }
      }),
    );
  }

  // snake_case alias requested by the integration design
  async send_alert(title, text, event = {}) {
    return this.sendAlert(title, text, event);
  }

  // Backward-compatible interface used by HealthMonitor:
  // event = { type: 'down'|'recovered', service, message, at }
  async notify(event = {}) {
    return this.sendAlert(event.title || '', event.message ?? event.text ?? '', event);
  }
}

function createNotifiers(configs = []) {
  return new NotificationManager(configs);
}

module.exports = {
  NotificationManager,
  Notifier,
  LogNotifier,
  WebhookNotifier,
  TelegramNotifier,
  DiscordNotifier,
  QQNotifier,
  createNotifiers,
};

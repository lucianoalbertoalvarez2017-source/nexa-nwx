// Nexa NWX — servidor Node puro (sin dependencias)
// Ejecutar: node server.js
// Persiste en db.json en el mismo directorio.
//
// Endpoints principales:
//   GET    /api/state                       Estado completo (sin API keys)
//   PUT    /api/state                       Reemplaza estado
//   GET    /api/integrations
//   PUT    /api/integrations/ai             Guarda config IA (puede incluir apiKey)
//   PUT    /api/integrations/whatsapp       Guarda config WhatsApp
//   PUT    /api/integrations/telegram       Guarda config Telegram
//   DELETE /api/integrations/ai/key
//   DELETE /api/integrations/whatsapp/token
//   POST   /api/ai/chat                     Proxy a Claude o OpenAI
//   GET    /api/whatsapp/webhook            Verificación de Meta
//   POST   /api/whatsapp/webhook            Recibe mensajes entrantes
//   POST   /api/whatsapp/send               Envía mensaje vía Cloud API
//   POST   /api/reset

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8765;
const DB_FILE = path.join(__dirname, 'db.json');
const PUBLIC_DIR = __dirname;

// === Persistencia ===
// Si hay variables de entorno de Upstash Redis, usa eso (persiste en producción).
// Si no, usa archivo local db.json (para desarrollo).
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);
const STATE_KEY = 'nexa_state_v1';

function defaultDB() {
  return {
    bots: [],
    conversations: [],
    settings: { businessName: 'Mi negocio' },
    integrations: {
      ai: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        apiKey: '',
        systemPrompt: 'Eres un asistente amable. Responde breve y en español.',
      },
      whatsapp: {
        connected: false,
        phoneNumber: '',
        phoneNumberId: '',
        verifyToken: '',
        accessToken: '',
      },
      telegram: { connected: false, botToken: '', botName: '' },
      messenger: { connected: false, pageId: '', pageName: '', accessToken: '' },
      instagram: { connected: false, accountId: '', username: '', accessToken: '' },
    },
  };
}

let db = defaultDB();

function mergeWithDefaults(data) {
  const def = defaultDB();
  return {
    ...def, ...data,
    integrations: {
      ...def.integrations, ...(data.integrations || {}),
      ai: { ...def.integrations.ai, ...(data.integrations?.ai || {}) },
      whatsapp: { ...def.integrations.whatsapp, ...(data.integrations?.whatsapp || {}) },
      telegram: { ...def.integrations.telegram, ...(data.integrations?.telegram || {}) },
      messenger: { ...def.integrations.messenger, ...(data.integrations?.messenger || {}) },
      instagram: { ...def.integrations.instagram, ...(data.integrations?.instagram || {}) },
    },
  };
}

async function loadDB() {
  if (useUpstash) {
    try {
      const r = await fetch(`${UPSTASH_URL}/get/${STATE_KEY}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      });
      const data = await r.json();
      if (data.result) {
        const parsed = JSON.parse(data.result);
        console.log('✓ Estado cargado desde Upstash Redis');
        return mergeWithDefaults(parsed);
      }
      console.log('⓪ Upstash vacío — usando estado por defecto');
    } catch (e) { console.error('Upstash load error:', e.message); }
    return defaultDB();
  }
  // Fallback: archivo local
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      return mergeWithDefaults(data);
    }
  } catch (e) { console.error('loadDB file error', e); }
  return defaultDB();
}

let _saveDebounce = null;
async function saveDB() {
  if (useUpstash) {
    // debounce: agrupa varios saves rápidos en uno
    clearTimeout(_saveDebounce);
    _saveDebounce = setTimeout(async () => {
      try {
        await fetch(`${UPSTASH_URL}/set/${STATE_KEY}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${UPSTASH_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(JSON.stringify(db)),
        });
      } catch (e) { console.error('Upstash save error:', e.message); }
    }, 200);
    return;
  }
  // Fallback: archivo local
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('saveDB file error', e); }
}

function safeState() {
  const safe = JSON.parse(JSON.stringify(db));
  if (safe.integrations?.ai) {
    safe.integrations.ai.hasKey = !!safe.integrations.ai.apiKey;
    delete safe.integrations.ai.apiKey;
  }
  if (safe.integrations?.whatsapp) {
    safe.integrations.whatsapp.hasToken = !!safe.integrations.whatsapp.accessToken;
    delete safe.integrations.whatsapp.accessToken;
  }
  if (safe.integrations?.telegram) {
    safe.integrations.telegram.hasToken = !!safe.integrations.telegram.botToken;
    delete safe.integrations.telegram.botToken;
  }
  if (safe.integrations?.messenger) {
    safe.integrations.messenger.hasToken = !!safe.integrations.messenger.accessToken;
    delete safe.integrations.messenger.accessToken;
  }
  if (safe.integrations?.instagram) {
    safe.integrations.instagram.hasToken = !!safe.integrations.instagram.accessToken;
    delete safe.integrations.instagram.accessToken;
  }
  return safe;
}

// ============================================================
// ROUTER
// ============================================================
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:[^/]+/g, m => {
    keys.push(m.slice(1));
    return '([^/]+)';
  }) + '$');
  routes.push({ method, re, keys, handler });
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}
function notFound(res, msg = 'Not Found') {
  res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
  res.end(msg);
}
function bad(res, msg) {
  res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ error: msg }));
}

// ============================================================
// API ROUTES
// ============================================================
route('GET', '/api/state', (req, res) => json(res, safeState()));

route('PUT', '/api/state', async (req, res) => {
  const body = await readBody(req);
  // Preserve API keys (frontend never sends them)
  const savedAiKey = db.integrations?.ai?.apiKey || '';
  const savedWaToken = db.integrations?.whatsapp?.accessToken || '';
  const savedTgToken = db.integrations?.telegram?.botToken || '';
  const savedMsgToken = db.integrations?.messenger?.accessToken || '';
  const savedIgToken = db.integrations?.instagram?.accessToken || '';
  db = body;
  if (!db.integrations) db.integrations = defaultDB().integrations;
  if (db.integrations.ai && !db.integrations.ai.apiKey) db.integrations.ai.apiKey = savedAiKey;
  if (db.integrations.whatsapp && !db.integrations.whatsapp.accessToken) db.integrations.whatsapp.accessToken = savedWaToken;
  if (db.integrations.telegram && !db.integrations.telegram.botToken) db.integrations.telegram.botToken = savedTgToken;
  if (db.integrations.messenger && !db.integrations.messenger.accessToken) db.integrations.messenger.accessToken = savedMsgToken;
  if (db.integrations.instagram && !db.integrations.instagram.accessToken) db.integrations.instagram.accessToken = savedIgToken;
  saveDB();
  json(res, { ok: true });
});

route('GET', '/api/integrations', (req, res) => json(res, safeState().integrations));

route('PUT', '/api/integrations/ai', async (req, res) => {
  const body = await readBody(req);
  db.integrations.ai = { ...db.integrations.ai, ...body };
  if (body.apiKey === '') delete body.apiKey; // empty means don't change
  saveDB();
  json(res, { ...db.integrations.ai, hasKey: !!db.integrations.ai.apiKey, apiKey: undefined });
});

route('DELETE', '/api/integrations/ai/key', (req, res) => {
  if (db.integrations?.ai) db.integrations.ai.apiKey = '';
  saveDB();
  json(res, { ok: true });
});

route('PUT', '/api/integrations/whatsapp', async (req, res) => {
  const body = await readBody(req);
  db.integrations.whatsapp = { ...db.integrations.whatsapp, ...body };
  if (body.accessToken === '') delete body.accessToken;
  db.integrations.whatsapp.connected = !!(db.integrations.whatsapp.accessToken && db.integrations.whatsapp.phoneNumberId);
  saveDB();
  const safe = { ...db.integrations.whatsapp, hasToken: !!db.integrations.whatsapp.accessToken };
  delete safe.accessToken;
  json(res, safe);
});

route('DELETE', '/api/integrations/whatsapp/token', (req, res) => {
  if (db.integrations?.whatsapp) {
    db.integrations.whatsapp.accessToken = '';
    db.integrations.whatsapp.connected = false;
  }
  saveDB();
  json(res, { ok: true });
});

route('PUT', '/api/integrations/telegram', async (req, res) => {
  const body = await readBody(req);
  db.integrations.telegram = { ...db.integrations.telegram, ...body };
  if (body.botToken === '') delete body.botToken;
  db.integrations.telegram.connected = !!db.integrations.telegram.botToken;
  saveDB();
  const safe = { ...db.integrations.telegram, hasToken: !!db.integrations.telegram.botToken };
  delete safe.botToken;
  json(res, safe);
});

// AI chat proxy
route('POST', '/api/ai/chat', async (req, res) => {
  const body = await readBody(req);
  const ai = db.integrations?.ai || defaultDB().integrations.ai;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemPrompt = body.systemPrompt || ai.systemPrompt || '';

  if (ai.provider === 'anthropic' && ai.apiKey) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ai.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ai.model || 'claude-sonnet-4-6',
          max_tokens: 400,
          system: systemPrompt,
          messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        console.error('Anthropic error', data);
        return json(res, { error: data.error?.message || 'AI error', reply: '(Error: ' + (data.error?.message || 'desconocido') + ')' }, 200);
      }
      const text = data.content?.[0]?.text || '(sin respuesta)';
      return json(res, { reply: text, usage: data.usage });
    } catch (e) {
      console.error('AI fetch error', e);
      return json(res, { reply: '(No pude conectar con Claude)', error: true }, 200);
    }
  }

  if (ai.provider === 'openai' && ai.apiKey) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ai.apiKey },
        body: JSON.stringify({
          model: ai.model || 'gpt-4o-mini',
          messages: [{ role:'system', content: systemPrompt }, ...messages],
          max_tokens: 400,
        }),
      });
      const data = await r.json();
      if (!r.ok) return json(res, { reply:'(Error OpenAI: ' + (data.error?.message || '') + ')', error: true });
      return json(res, { reply: data.choices?.[0]?.message?.content || '(sin respuesta)' });
    } catch (e) {
      return json(res, { reply:'(No pude conectar con OpenAI)', error: true });
    }
  }

  // Demo mode
  const last = messages[messages.length - 1]?.content?.toLowerCase() || '';
  let reply = '';
  if (/hola|hi|hey/.test(last)) reply = `¡Hola! Soy un bot demo. Configura tu API key en Integraciones para respuestas reales.`;
  else if (/precio|costo/.test(last)) reply = 'Configura tu Claude/OpenAI key para que pueda responder dinámicamente sobre precios.';
  else reply = `Estoy en modo demo (sin API key). Recibí: "${last.slice(0, 60)}". Agrega tu API key en Integraciones.`;
  json(res, { reply, demo: true });
});

// WhatsApp Cloud API: send
route('POST', '/api/whatsapp/send', async (req, res) => {
  const body = await readBody(req);
  const wa = db.integrations?.whatsapp;
  if (!wa?.accessToken || !wa?.phoneNumberId) return bad(res, 'WhatsApp no configurado');
  const { to, text } = body;
  if (!to || !text) return bad(res, 'to y text requeridos');
  try {
    const r = await fetch(`https://graph.facebook.com/v18.0/${wa.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + wa.accessToken },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace(/\D/g, ''),
        type: 'text',
        text: { body: text },
      }),
    });
    const data = await r.json();
    if (!r.ok) return json(res, { error: data.error?.message }, 500);
    json(res, { ok: true, data });
  } catch (e) {
    json(res, { error: 'Error enviando' }, 500);
  }
});

// WhatsApp webhook verify (GET) — Meta sends ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
route('GET', '/api/whatsapp/webhook', (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const mode = u.searchParams.get('hub.mode');
  const token = u.searchParams.get('hub.verify_token');
  const challenge = u.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token === db.integrations?.whatsapp?.verifyToken) {
    res.writeHead(200);
    res.end(challenge || '');
    console.log('✓ Webhook de WhatsApp verificado');
  } else {
    res.writeHead(403);
    res.end('Forbidden');
  }
});

// WhatsApp webhook receive (POST)
route('POST', '/api/whatsapp/webhook', async (req, res) => {
  const body = await readBody(req);
  console.log('📨 WhatsApp webhook recibido:', JSON.stringify(body).slice(0, 200));
  try {
    const entry = body.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (msg) {
      const from = msg.from;
      const text = msg.text?.body || '';
      console.log(`  De ${from}: "${text}"`);
      // Log conversation
      db.conversations.push({
        id: Math.random().toString(36).slice(2, 8),
        botId: null,
        userName: from,
        channel: 'whatsapp',
        startedAt: Date.now(),
        completed: false,
        messages: 1,
        variables: { phone: from, lastMessage: text },
      });
      saveDB();
    }
  } catch (e) { console.error(e); }
  res.writeHead(200);
  res.end('EVENT_RECEIVED');
});

// === Messenger ===
route('PUT', '/api/integrations/messenger', async (req, res) => {
  const body = await readBody(req);
  db.integrations.messenger = { ...db.integrations.messenger, ...body };
  if (body.accessToken === '') delete body.accessToken;
  db.integrations.messenger.connected = !!(db.integrations.messenger.accessToken && db.integrations.messenger.pageId);
  saveDB();
  const safe = { ...db.integrations.messenger, hasToken: !!db.integrations.messenger.accessToken };
  delete safe.accessToken;
  json(res, safe);
});
route('DELETE', '/api/integrations/messenger/token', (req, res) => {
  if (db.integrations?.messenger) {
    db.integrations.messenger.accessToken = '';
    db.integrations.messenger.connected = false;
  }
  saveDB();
  json(res, { ok: true });
});
route('POST', '/api/messenger/send', async (req, res) => {
  const body = await readBody(req);
  const m = db.integrations?.messenger;
  if (!m?.accessToken || !m?.pageId) return bad(res, 'Messenger no configurado');
  const { to, text } = body;
  if (!to || !text) return bad(res, 'to (PSID) y text requeridos');
  try {
    const r = await fetch(`https://graph.facebook.com/v18.0/${m.pageId}/messages?access_token=${encodeURIComponent(m.accessToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: to },
        message: { text },
        messaging_type: 'RESPONSE',
      }),
    });
    const data = await r.json();
    if (!r.ok) return json(res, { error: data.error?.message }, 500);
    json(res, { ok: true, data });
  } catch (e) { json(res, { error: 'Error enviando' }, 500); }
});
route('GET', '/api/messenger/webhook', (req, res) => {
  // Same Meta verify flow as WhatsApp
  const u = new URL(req.url, 'http://localhost');
  const mode = u.searchParams.get('hub.mode');
  const token = u.searchParams.get('hub.verify_token');
  const challenge = u.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token === db.integrations?.whatsapp?.verifyToken) {
    res.writeHead(200); res.end(challenge || '');
    console.log('✓ Webhook de Messenger verificado');
  } else { res.writeHead(403); res.end('Forbidden'); }
});
route('POST', '/api/messenger/webhook', async (req, res) => {
  const body = await readBody(req);
  console.log('📨 Messenger webhook:', JSON.stringify(body).slice(0, 200));
  try {
    const entry = body.entry?.[0];
    const event = entry?.messaging?.[0];
    if (event?.message) {
      const psid = event.sender?.id;
      const text = event.message?.text || '';
      console.log(`  De ${psid}: "${text}"`);
      db.conversations.push({
        id: Math.random().toString(36).slice(2, 8),
        botId: null,
        userName: 'Messenger user',
        channel: 'messenger',
        startedAt: Date.now(),
        completed: false,
        messages: 1,
        variables: { psid, lastMessage: text },
      });
      saveDB();
    }
  } catch (e) { console.error(e); }
  res.writeHead(200); res.end('EVENT_RECEIVED');
});

// === Instagram (mismo Meta Graph API) ===
route('PUT', '/api/integrations/instagram', async (req, res) => {
  const body = await readBody(req);
  db.integrations.instagram = { ...db.integrations.instagram, ...body };
  if (body.accessToken === '') delete body.accessToken;
  db.integrations.instagram.connected = !!(db.integrations.instagram.accessToken && db.integrations.instagram.accountId);
  saveDB();
  const safe = { ...db.integrations.instagram, hasToken: !!db.integrations.instagram.accessToken };
  delete safe.accessToken;
  json(res, safe);
});
route('DELETE', '/api/integrations/instagram/token', (req, res) => {
  if (db.integrations?.instagram) {
    db.integrations.instagram.accessToken = '';
    db.integrations.instagram.connected = false;
  }
  saveDB();
  json(res, { ok: true });
});
route('POST', '/api/instagram/send', async (req, res) => {
  const body = await readBody(req);
  const ig = db.integrations?.instagram;
  if (!ig?.accessToken || !ig?.accountId) return bad(res, 'Instagram no configurado');
  const { to, text } = body;
  if (!to || !text) return bad(res, 'to (IGSID) y text requeridos');
  try {
    const r = await fetch(`https://graph.facebook.com/v18.0/${ig.accountId}/messages?access_token=${encodeURIComponent(ig.accessToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: to },
        message: { text },
      }),
    });
    const data = await r.json();
    if (!r.ok) return json(res, { error: data.error?.message }, 500);
    json(res, { ok: true, data });
  } catch (e) { json(res, { error: 'Error enviando' }, 500); }
});
route('GET', '/api/instagram/webhook', (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const mode = u.searchParams.get('hub.mode');
  const token = u.searchParams.get('hub.verify_token');
  const challenge = u.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token === db.integrations?.whatsapp?.verifyToken) {
    res.writeHead(200); res.end(challenge || '');
    console.log('✓ Webhook de Instagram verificado');
  } else { res.writeHead(403); res.end('Forbidden'); }
});
route('POST', '/api/instagram/webhook', async (req, res) => {
  const body = await readBody(req);
  console.log('📨 Instagram webhook:', JSON.stringify(body).slice(0, 200));
  try {
    const entry = body.entry?.[0];
    const event = entry?.messaging?.[0];
    if (event?.message) {
      const igsid = event.sender?.id;
      const text = event.message?.text || '';
      console.log(`  De ${igsid}: "${text}"`);
      db.conversations.push({
        id: Math.random().toString(36).slice(2, 8),
        botId: null,
        userName: 'Instagram user',
        channel: 'instagram',
        startedAt: Date.now(),
        completed: false,
        messages: 1,
        variables: { igsid, lastMessage: text },
      });
      saveDB();
    }
  } catch (e) { console.error(e); }
  res.writeHead(200); res.end('EVENT_RECEIVED');
});

route('POST', '/api/reset', (req, res) => {
  db = defaultDB();
  saveDB();
  json(res, { ok: true });
});

// ============================================================
// STATIC FILES
// ============================================================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  const clean = urlPath === '/' ? '/index.html' : urlPath.split('?')[0];
  const file = path.join(PUBLIC_DIR, clean);
  if (!file.startsWith(PUBLIC_DIR)) return notFound(res);
  fs.readFile(file, (err, data) => {
    if (err) return notFound(res);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

// ============================================================
// SERVER
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    });
    return res.end();
  }
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;

  if (pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i+1]));
        try { await r.handler(req, res, params); }
        catch (e) {
          console.error('Handler error', e);
          res.writeHead(500, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
          res.end(JSON.stringify({ error:'Server error' }));
        }
        return;
      }
    }
    return notFound(res, 'API endpoint not found');
  }

  serveStatic(res, pathname);
});

(async () => {
  db = await loadDB();
  server.listen(PORT, () => {
    console.log('');
    console.log('  ╔════════════════════════════════════════╗');
    console.log('  ║         Nexa NWX  —  API + UI          ║');
    console.log('  ╚════════════════════════════════════════╝');
    console.log('');
    console.log('  Frontend:        http://localhost:' + PORT + '/');
    console.log('  API:             http://localhost:' + PORT + '/api/');
    console.log('  Persistencia:    ' + (useUpstash ? '🌐 Upstash Redis (PERSISTE)' : '📁 ' + DB_FILE));
    console.log('');
    console.log('  Para usar IA real: ve a Integraciones y pega tu API key.');
    console.log('  Detener con Ctrl+C');
    console.log('');
  });
})();



 
  

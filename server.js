// AI Subtitles — Stremio subtitles addon that translates English subtitles into the chosen
// language, using each user's own AI (and key). No dependencies: plain Node.
// Each user's config travels encrypted inside their own install link.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 7311);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/$/, '');
// path prefix when the addon lives in a subdirectory (e.g. https://example.com/ai-subtitles)
const BASE_PATH = new URL(PUBLIC_URL).pathname.replace(/\/$/, '');
const SECRET = process.env.CONFIG_SECRET || '';
const REAL_IP_HEADER = (process.env.REAL_IP_HEADER || '').toLowerCase(); // e.g. cf-connecting-ip, x-real-ip
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_MAX_MB = Number(process.env.CACHE_MAX_MB || 2000);
const CACHE_MAX_DAYS = Number(process.env.CACHE_MAX_DAYS || 60);
const JOBS_PER_IP_HOUR = Number(process.env.JOBS_PER_IP_HOUR || 30);
const MAX_JOBS = Number(process.env.MAX_JOBS || 10);
const OPENSUBS = 'https://opensubtitles-v3.strem.io';
const CINEMETA = 'https://v3-cinemeta.strem.io'; // title name/genre/plot, to give the AI context
const BATCH_SIZE = 50;         // lines per AI request
const PARALLEL = 4;            // concurrent AI requests per subtitle

// Stremio languages (generated from github.com/Stremio/nodejs-langs, field "2"); English is left out as the source
const LANGS = require('./languages.json');
const LANG = Object.fromEntries(LANGS.map(l => [l.code, l]));

// default models checked against the official docs on 2026-10-12
// OpenAI-compatible providers use /chat/completions and /models on the base URL; Anthropic has its own API
const PROVIDERS = {
  openai:     { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-6-luna' },
  anthropic:  { name: 'Anthropic (Claude)', base: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5', native: 'anthropic' },
  gemini:     { name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash-lite' },
  groq:       { name: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  openrouter: { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: 'google/gemini-3.5-flash-lite' },
  deepseek:   { name: 'DeepSeek', base: 'https://api.deepseek.com', model: 'deepseek-flash' },
  mistral:    { name: 'Mistral', base: 'https://api.mistral.ai/v1', model: 'mistral-small-2603' },
  xai:        { name: 'xAI (Grok)', base: 'https://api.x.ai/v1', model: 'grok-4.3' },
  custom:     { name: 'Custom (OpenAI-compatible)', base: '', model: '' },
};

fs.mkdirSync(CACHE_DIR, { recursive: true });

const manifestBase = {
  id: 'dev.luizsilva.ai-subtitles',
  version: '2.0.0',
  name: 'AI Subtitles',
  description: 'Translates English subtitles into your language with your own AI (OpenAI, Claude, Gemini, Groq, OpenRouter, DeepSeek, Mistral, Grok or any OpenAI-compatible endpoint).',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

// ---------- utilities ----------

const log = (...a) => console.log(new Date().toISOString(), ...a);

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function fetchText(url, opts = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const body = await r.text();
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
      err.status = r.status;
      err.retryAfter = Number(r.headers.get('retry-after')) || 0;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function clientIp(req) {
  const h = REAL_IP_HEADER && req.headers[REAL_IP_HEADER];
  return (h ? String(h).split(',')[0].trim() : '') || req.socket.remoteAddress || '?';
}

// ---------- config in the link (AES-256-GCM) ----------
// fields: p provider, k key, m model, u custom endpoint URL, l language, n number of options

const aesKey = crypto.createHash('sha256').update(SECRET).digest();

function sealConfig(cfg) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const data = Buffer.concat([c.update(JSON.stringify(cfg)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64url');
}

function openConfig(token) {
  try {
    const buf = Buffer.from(token, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', aesKey, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return validConfig(JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString()));
  } catch {
    return null;
  }
}

// returns the clean config or null; throws an Error with a friendly message when called with strict
function validConfig(c, strict = false) {
  const fail = msg => { if (strict) throw new Error(msg); return null; };
  if (!c || typeof c !== 'object') return fail('Invalid configuration.');
  const p = String(c.p || '');
  if (!PROVIDERS[p]) return fail('Choose an AI provider.');
  const k = String(c.k || '').trim();
  if (!k || k.length > 400) return fail('Enter your API key.');
  const m = String(c.m || PROVIDERS[p].model).trim();
  if (!m || m.length > 120) return fail('Enter a model name.');
  let u = '';
  if (p === 'custom') {
    u = String(c.u || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(u) || u.length > 300) return fail('The custom endpoint must be an https:// URL.');
  }
  const l = String(c.l || '');
  if (!LANG[l]) return fail('Choose a language.');
  const n = Number(c.n || 1);
  if (!(n >= 1 && n <= 5)) return fail('Invalid number of options.');
  return { p, k, m, u, l, n };
}

// ---------- custom endpoint guard (never point at the internal network) ----------

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return privateIp(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

const safeHosts = new Map(); // host → expiry
async function assertPublicUrl(u) {
  const host = new URL(u).hostname.replace(/^\[|\]$/g, '');
  if ((safeHosts.get(host) || 0) > Date.now()) return;
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new Error('The custom endpoint must be a public address.');
  safeHosts.set(host, Date.now() + 10 * 60000);
}

// ---------- AI ----------

const baseUrl = cfg => (cfg.p === 'custom' ? cfg.u : PROVIDERS[cfg.p].base);

async function chat(cfg, system, user, timeoutMs = 120000) {
  const base = baseUrl(cfg);
  if (cfg.p === 'custom') await assertPublicUrl(base);
  if (PROVIDERS[cfg.p].native === 'anthropic') {
    const raw = await fetchText(`${base}/messages`, {
      method: 'POST',
      headers: { 'x-api-key': cfg.k, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.m, max_tokens: 16000, system, messages: [{ role: 'user', content: user }] }),
    }, timeoutMs);
    return (JSON.parse(raw).content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  const raw = await fetchText(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg.k}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.m,
      stream: false,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  }, timeoutMs);
  return JSON.parse(raw).choices[0].message.content || '';
}

async function listModels(cfg) {
  const base = baseUrl(cfg);
  if (cfg.p === 'custom') await assertPublicUrl(base);
  const headers = PROVIDERS[cfg.p].native === 'anthropic'
    ? { 'x-api-key': cfg.k, 'anthropic-version': '2023-06-01' }
    : { 'Authorization': `Bearer ${cfg.k}` };
  const data = JSON.parse(await fetchText(`${base}/models${cfg.p === 'anthropic' ? '?limit=100' : ''}`, { headers }, 15000));
  const ids = (Array.isArray(data) ? data : data.data || data.models || []).map(m => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
  return [...new Set(ids)].sort();
}

// AI error in plain words (shown inside the subtitle and on the page)
function friendlyError(e) {
  if (e.status === 401 || e.status === 403) return 'invalid API key or no access to this model';
  if (e.status === 404) return 'model or endpoint not found';
  if (e.status === 429) return 'rate limit or no credits left on your AI account';
  if (e.status === 402) return 'no credits left on your AI account';
  if (e.name === 'AbortError') return 'the AI took too long to answer';
  // the provider's error body is never passed on: some echo part of the key
  if (e.status) return `the AI answered with HTTP ${e.status}`;
  return e.message.replace(/\.$/, '').slice(0, 160);
}

const JARGON_PT = `
- Examples for Brazilian Portuguese: "engine" (fire truck) → "caminhão", "ladder" (truck/company) →
  "escada" or "caminhão-escada", "battalion chief" → "comandante", "EMT/paramedic" → "socorrista",
  "ER" → "pronto-socorro", "DOA" → "chegou sem vida", "perp" → "suspeito", "DA" → "promotor",
  "APB/BOLO" → "alerta geral", "10-4" → "entendido", "copy" (radio) → "na escuta"/"entendido",
  "code 3" → "com sirene", "stat" → "agora", "v-fib" → "parada cardíaca".`;

function systemPrompt(lang, ctx) {
  const L = LANG[lang];
  const target = `${L.name} (${L.local})`;
  return `You translate movie/TV subtitles from English to ${target}.

The audience is an ordinary viewer with no background in the show's field. Every line must be
understood at first read, in the 2-3 seconds it stays on screen.

- Natural, colloquial ${L.name}, as heard in good professional dubbing. Translate the meaning, never word by word.
- Professional jargon (firefighting, police, medical, military, legal, technical): use the term a native
  speaker would actually hear in that situation. If there is no common equivalent, say plainly what it
  means, in short words.${lang === 'pob' || lang === 'por' ? JARGON_PT : ''}
- Never leave unexplained English acronyms or codes. Never add notes, parentheses or explanations.
- Keep it short; prefer shorter wording when the meaning is the same.
- Keep the speakers' tone: slang, swearing and humor stay, adapted to natural equivalents.
- Keep names of people and places. Keep line breaks (\\n) and tags like <i></i> where they are.

You receive a JSON object mapping ids to subtitle lines. Reply ONLY with a JSON object with exactly
the same ids, each value being the translation. Do not merge or skip ids.` +
    (ctx ? `\n\nWhat is being watched (use it to pick the right vocabulary):\n${ctx}` : '');
}

// title context (name, genre, plot) from Cinemeta; null if not found
const metaCache = new Map();
async function titleContext(type, id) {
  const imdb = id.split(':')[0];
  if (metaCache.has(imdb)) return metaCache.get(imdb);
  let ctx = null;
  try {
    const { meta } = JSON.parse(await fetchText(`${CINEMETA}/meta/${type}/${imdb}.json`, {}, 8000));
    if (meta && meta.name) {
      ctx = `Title: ${meta.name}${meta.year ? ` (${meta.year})` : ''}` +
        (meta.genre && meta.genre.length ? `\nGenre: ${meta.genre.join(', ')}` : '') +
        (meta.description ? `\nPlot: ${meta.description}` : '');
    }
  } catch (e) {
    log(`no context for ${imdb}:`, e.message);
  }
  if (metaCache.size > 5000) metaCache.clear();
  metaCache.set(imdb, ctx);
  return ctx;
}

async function translateBatch(cfg, system, batch) {
  const input = {};
  batch.forEach(c => { input[c.idx] = c.text; });
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const content = await chat(cfg, system, JSON.stringify(input));
      const json = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
      return batch.map(c => (typeof json[c.idx] === 'string' && json[c.idx].trim()) ? json[c.idx] : c.text);
    } catch (e) {
      last = e;
      if (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 402) throw e; // retrying won't help
      await sleep(e.status === 429 ? Math.min(30, e.retryAfter || 5 * attempt) * 1000 : 1000 * attempt);
    }
  }
  if (last && last.status === 429) throw last;
  return batch.map(c => c.text); // give up: keep the English for this batch
}

// ---------- SRT ----------

function parseSrt(text) {
  const blocks = text.replace(/^﻿/, '').replace(/\r/g, '').trim().split(/\n\s*\n/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const body = lines.slice(i + 1).join('\n').trim();
    if (body) cues.push({ time: lines[i].trim(), text: body });
  }
  return cues;
}

const buildSrt = cues => cues.map((c, i) => `${i + 1}\n${c.time}\n${c.text}\n`).join('\n');
const srtMs = t => { const [h, m, x] = t.split(':'); const [sec, ms] = x.split(','); return ((+h * 60 + +m) * 60 + +sec) * 1000 + +ms; };
const msSrt = ms => new Date(ms).toISOString().slice(11, 23).replace('.', ',');

// ---------- texts shown inside the subtitle ----------

const UI = {
  en: { working: p => `Translating with AI… ${p}%`, reopen: 'Open the subtitle again in a moment.', option: (i, n) => `Option ${i} of ${n}`, matched: 'made for this video file', sdh: 'with sound descriptions', error: 'AI error', fix: 'Check the AI Subtitles configuration.', busy: 'Server busy, try again in a minute.', limit: 'Too many new translations, try again later.' },
  pt: { working: p => `Traduzindo com IA… ${p}%`, reopen: 'Abra a legenda de novo em instantes.', option: (i, n) => `Opção ${i} de ${n}`, matched: 'feita para este arquivo de vídeo', sdh: 'com descrição de sons', error: 'Erro da IA', fix: 'Confira a configuração do AI Subtitles.', busy: 'Servidor ocupado, tente de novo em um minuto.', limit: 'Muitas traduções novas, tente mais tarde.' },
  es: { working: p => `Traduciendo con IA… ${p}%`, reopen: 'Vuelve a abrir el subtítulo en un momento.', option: (i, n) => `Opción ${i} de ${n}`, matched: 'hecho para este archivo de video', sdh: 'con descripción de sonidos', error: 'Error de la IA', fix: 'Revisa la configuración de AI Subtitles.', busy: 'Servidor ocupado, inténtalo en un minuto.', limit: 'Demasiadas traducciones nuevas, inténtalo más tarde.' },
  fr: { working: p => `Traduction par IA… ${p}%`, reopen: 'Rouvrez le sous-titre dans un instant.', option: (i, n) => `Option ${i} sur ${n}`, matched: 'fait pour ce fichier vidéo', sdh: 'avec description des sons', error: "Erreur de l'IA", fix: 'Vérifiez la configuration de AI Subtitles.', busy: 'Serveur occupé, réessayez dans une minute.', limit: 'Trop de nouvelles traductions, réessayez plus tard.' },
  de: { working: p => `Übersetzung mit KI… ${p}%`, reopen: 'Öffne den Untertitel gleich noch einmal.', option: (i, n) => `Option ${i} von ${n}`, matched: 'passend zu dieser Videodatei', sdh: 'mit Geräuschbeschreibungen', error: 'KI-Fehler', fix: 'Prüfe die Konfiguration von AI Subtitles.', busy: 'Server ausgelastet, versuche es in einer Minute.', limit: 'Zu viele neue Übersetzungen, versuche es später.' },
  it: { working: p => `Traduzione con IA… ${p}%`, reopen: 'Riapri il sottotitolo tra poco.', option: (i, n) => `Opzione ${i} di ${n}`, matched: 'fatto per questo file video', sdh: 'con descrizione dei suoni', error: "Errore dell'IA", fix: 'Controlla la configurazione di AI Subtitles.', busy: 'Server occupato, riprova tra un minuto.', limit: 'Troppe nuove traduzioni, riprova più tardi.' },
};
const UI_BY_LANG = { pob: 'pt', por: 'pt', spa: 'es', spl: 'es', fre: 'fr', ger: 'de', ita: 'it' };
const ui = lang => UI[UI_BY_LANG[lang] || 'en'];

function describeSource(s, i, n, lang) {
  const t = ui(lang);
  const group = (s.releaseGroup || '').replace(/\.(srt|txt|sub)$/i, '');
  const first = [t.option(i + 1, n), s.releaseFormat, group].filter(Boolean).join(' · ');
  const extras = [];
  if (s.m === 'h') extras.push(t.matched);
  if (/[-._ ](HI|SDH)[-._ ]/i.test(s.subtitleFileName || '')) extras.push(t.sdh);
  return extras.length ? `${first}\n${extras.join(' · ')}` : first;
}

// the TV app shows no per-subtitle label, so the file info goes inside the subtitle itself:
// in the first 2 s+ silence within the first 30 s, or attached to the first line
function withInfo(cues, info) {
  if (!info) return cues;
  const span = c => c.time.split(' --> ').map(srtMs);
  let prevEnd = 0;
  for (let i = 0; i <= cues.length; i++) {
    const start = i < cues.length ? span(cues[i])[0] : prevEnd + 5100;
    if (prevEnd > 30000) break;
    if (start - prevEnd >= 2000) {
      const cue = { time: `${msSrt(prevEnd + 100)} --> ${msSrt(Math.min(start - 100, prevEnd + 5100))}`, text: info };
      return [...cues.slice(0, i), cue, ...cues.slice(i)];
    }
    if (i < cues.length) prevEnd = span(cues[i])[1];
  }
  return cues.length ? [{ ...cues[0], text: `${cues[0].text}\n[${info.replace(/\n/g, ' · ')}]` }, ...cues.slice(1)] : cues;
}

const noteSrt = (lines, extra = []) => buildSrt([{ time: '00:00:00,000 --> 00:00:10,000', text: lines.filter(Boolean).join('\n') }, ...extra]);

// ---------- cache and jobs ----------
// cache/{lang}/{key}.srt — shared across users; mtime marks the last use

const cachePath = (lang, key) => path.join(CACHE_DIR, lang, `${key}.srt`);
const jobs = new Map();     // `${lang}/${key}` → { cues, done, total }
const failures = new Map(); // `${lang}/${key}|${key owner}` → { msg, at } (shows the error for a few minutes, only to whoever caused it)
const failId = (cfg, id) => `${id}|${crypto.createHash('sha256').update(cfg.k).digest('hex').slice(0, 16)}`;
const ipJobs = new Map();   // ip → [timestamps of started translations]

function canStart(ip) {
  const now = Date.now();
  const list = (ipJobs.get(ip) || []).filter(t => now - t < 3600000);
  ipJobs.set(ip, list);
  if (list.length >= JOBS_PER_IP_HOUR) return 'limit';
  if (jobs.size >= MAX_JOBS) return 'busy';
  list.push(now);
  return '';
}

function startTranslation(cfg, key, sourceUrl, ctx, ip) {
  const id = `${cfg.l}/${key}`;
  if (fs.existsSync(cachePath(cfg.l, key)) || jobs.has(id)) return '';
  const f = failures.get(failId(cfg, id));
  if (f && Date.now() - f.at < 120000) return '';
  const blocked = canStart(ip);
  if (blocked) return blocked;
  failures.delete(failId(cfg, id));
  const job = { cues: null, done: 0, total: 0 };
  jobs.set(id, job);
  (async () => {
    try {
      const cues = parseSrt(await fetchText(sourceUrl));
      if (!cues.length) throw new Error('empty source subtitle');
      job.cues = cues.map(c => ({ ...c }));
      const batches = [];
      for (let i = 0; i < cues.length; i += BATCH_SIZE) {
        batches.push(cues.slice(i, i + BATCH_SIZE).map((c, j) => ({ idx: i + j, text: c.text })));
      }
      job.total = batches.length;
      const system = systemPrompt(cfg.l, ctx);
      log(`translating ${id} (${cfg.p}/${cfg.m}): ${cues.length} lines, ${batches.length} batches`);
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const b = batches[next++];
          const out = await translateBatch(cfg, system, b);
          b.forEach((c, j) => { job.cues[c.idx].text = out[j]; job.cues[c.idx].ok = true; });
          job.done++;
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      fs.mkdirSync(path.join(CACHE_DIR, cfg.l), { recursive: true });
      fs.writeFileSync(cachePath(cfg.l, key), buildSrt(job.cues));
      log(`done ${id}`);
    } catch (e) {
      log(`failed ${id} (${cfg.p}/${cfg.m}):`, e.status || '', friendlyError(e));
      if (failures.size > 5000) failures.clear();
      failures.set(failId(cfg, id), { msg: friendlyError(e), at: Date.now() });
    } finally {
      jobs.delete(id);
    }
  })();
  return '';
}

function progressSrt(cfg, key, info, blocked) {
  const t = ui(cfg.l);
  const id = `${cfg.l}/${key}`;
  if (blocked) return noteSrt([t[blocked]]);
  const f = failures.get(failId(cfg, id));
  if (f && Date.now() - f.at < 120000) return noteSrt([`${t.error}: ${f.msg}`, t.fix]);
  const job = jobs.get(id);
  const pct = job && job.total ? Math.round((job.done / job.total) * 100) : 0;
  const lines = [t.working(pct), t.reopen, info && info.split('\n')[0]];
  // what is already translated shows up; the rest is left out until ready
  return noteSrt(lines, job && job.cues ? job.cues.filter(c => c.ok) : []);
}

// cleanup: deletes what hasn't been used for CACHE_MAX_DAYS and, above CACHE_MAX_MB, the oldest files
function cleanCache() {
  const files = [];
  for (const lang of fs.readdirSync(CACHE_DIR)) {
    const dir = path.join(CACHE_DIR, lang);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      files.push({ p, size: st.size, used: st.mtimeMs });
    }
  }
  const old = Date.now() - CACHE_MAX_DAYS * 86400000;
  let total = 0, removed = 0;
  files.sort((a, b) => b.used - a.used);
  for (const f of files) {
    total += f.size;
    if (f.used < old || total > CACHE_MAX_MB * 1048576) { fs.unlinkSync(f.p); removed++; }
  }
  if (removed) log(`cache cleanup: removed ${removed} files`);
}

// ---------- Stremio routes ----------

// key = source subtitle id on OpenSubtitles; the source URL is encoded in the link
const encodeSrc = url => Buffer.from(url).toString('base64url');
const decodeSrc = s => Buffer.from(s, 'base64url').toString();
const keyFor = (osId, url) => `${osId}-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 8)}`;

// stored when Stremio asks for the list (before asking for the .srt): title context and option info
const subMeta = new Map(); // `${lang}/${key}` → { ctx, info }

async function handleSubtitles(cfg, token, type, id, extra, ip) {
  const q = extra ? `/${extra}` : '';
  const data = JSON.parse(await fetchText(`${OPENSUBS}/subtitles/${type}/${encodeURIComponent(id)}${q}.json`, {}, 20000));
  const english = (data.subtitles || []).filter(s => s.lang === 'eng').slice(0, cfg.n);
  const ctx = await titleContext(type, id);
  if (subMeta.size > 20000) subMeta.clear();
  return english.map((s, i) => {
    const key = keyFor(s.id, s.url);
    subMeta.set(`${cfg.l}/${key}`, { ctx, info: describeSource(s, i, english.length, cfg.l) });
    if (i === 0) startTranslation(cfg, key, s.url, ctx, ip); // start translating the best option right away
    return {
      id: `ai-${cfg.l}-${key}`,
      lang: cfg.l,
      url: `${PUBLIC_URL}/${token}/sub/${key}/${encodeSrc(s.url)}.srt`,
    };
  });
}

function serveSub(res, cfg, key, src, ip) {
  const srt = 'application/x-subrip; charset=utf-8';
  const meta = subMeta.get(`${cfg.l}/${key}`) || {};
  const file = cachePath(cfg.l, key);
  if (fs.existsSync(file)) {
    const now = new Date();
    try { fs.utimesSync(file, now, now); } catch {}
    return send(res, 200, buildSrt(withInfo(parseSrt(fs.readFileSync(file, 'utf8')), meta.info)), srt);
  }
  const srcUrl = decodeSrc(src);
  if (!/^https:\/\/[\w.-]+\.strem\.io\//.test(srcUrl)) return send(res, 400, { error: 'invalid source' });
  const blocked = startTranslation(cfg, key, srcUrl, meta.ctx || null, ip);
  return send(res, 200, progressSrt(cfg, key, meta.info, blocked), srt);
}

// ---------- configuration page ----------

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function configurePage(cfg, token) {
  const cur = cfg || { p: 'openai', m: '', u: '', l: 'pob', n: 1 };
  const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
  const providers = Object.entries(PROVIDERS).map(([id, p]) => opt(id, p.name, id === cur.p)).join('');
  const langs = LANGS.map(l => opt(l.code, l.local && l.local !== l.name ? `${l.name} — ${l.local}` : l.name, l.code === cur.l)).join('');
  const defaults = Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, p.model]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Subtitles</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232f9e74'/%3E%3Crect x='7' y='18' width='18' height='3' rx='1.5' fill='white'/%3E%3Crect x='10' y='23' width='12' height='3' rx='1.5' fill='white'/%3E%3C/svg%3E">
<meta name="description" content="Stremio addon that translates subtitles into your language with your own AI key.">
<style>
:root{--bg:#121316;--card:#1b1c21;--txt:#ececf0;--mut:#a0a1ab;--acc:#2f9e74;--accd:#257d5c;--line:#2c2d34;--err:#e5484d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:24px 16px}
main{max-width:560px;margin:0 auto}h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}p.sub{color:var(--mut);margin:0 0 24px}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
h2{font-size:13px;margin:0 0 14px;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
label{display:block;margin:0 0 6px;font-weight:500}small{display:block;color:var(--mut);margin:-8px 0 14px;font-size:13px}
select,input{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--txt);font-size:16px;margin-bottom:14px}
select:focus,input:focus{outline:2px solid var(--acc);outline-offset:1px}
.row{display:grid;grid-template-columns:1fr auto;gap:8px}.row button{margin-bottom:14px;width:auto;padding:0 14px}
button,.btn{display:block;width:100%;text-align:center;padding:14px;border-radius:10px;border:0;background:var(--acc);color:#fff;font-size:16px;font-weight:600;text-decoration:none;cursor:pointer}
button:active,.btn:active{transform:translateY(1px)}button:hover,.btn:hover{background:var(--accd)}
button.sec{background:transparent;border:1px solid var(--line);color:var(--txt)}button.sec:hover{background:var(--line)}
.out{display:none;margin-top:14px}.out.on{display:block}.msg{padding:12px;border-radius:10px;margin-top:12px;font-size:15px;display:none}
.msg.ok{display:block;background:#17301f;border:1px solid #2b5a3b;color:#b8efc9}.msg.bad{display:block;background:#3a1719;border:1px solid #6b2a2e;color:#ffc9cb}
code{display:block;word-break:break-all;color:var(--mut);font-size:13px;margin-top:10px}
ol,ul{margin:0;padding-left:20px;color:var(--mut)}li{margin-bottom:6px}
.hide{display:none}
</style></head><body><main>
<h1>AI Subtitles</h1><p class="sub">Stremio addon · translates English subtitles into your language with your own AI · v${esc(manifestBase.version)}</p>

<section><h2>Your AI</h2>
<label for="p">Provider</label><select id="p">${providers}</select>
<div id="uwrap" class="${cur.p === 'custom' ? '' : 'hide'}"><label for="u">Endpoint URL</label>
<input id="u" type="url" placeholder="https://example.com/v1" value="${esc(cur.u)}"><small>OpenAI-compatible base URL (the addon calls /chat/completions on it).</small></div>
<label for="k">API key</label><input id="k" type="password" autocomplete="off" placeholder="${cfg ? 'Saved — leave empty to keep it' : 'Paste your key'}">
<small>Stored only inside your install link, encrypted. Translations use your account. Don't share your install link: it carries your key.</small>
<label for="m">Model</label><div class="row"><input id="m" list="models" value="${esc(cur.m)}" placeholder=""><button class="sec" id="load" type="button">Load list</button></div>
<datalist id="models"></datalist>
<button class="sec" id="test" type="button">Test</button><div class="msg" id="testmsg"></div>
</section>

<section><h2>Subtitles</h2>
<label for="l">Translate into</label><select id="l">${langs}</select>
<small>This is also the language that shows up in Stremio's subtitle menu.</small>
<label for="n">Options in the menu</label><select id="n">${[1, 2, 3, 4, 5].map(n => opt(n, n, n === cur.n)).join('')}</select>
<small>Each option is a different English subtitle file (different video releases). Use more than 1 if the timing is off.</small>
</section>

<section><h2>Install</h2>
<button id="save" type="button">Install in Stremio</button><div class="msg" id="savemsg"></div>
<div class="out" id="out"><a class="btn" id="open" href="#">Open in Stremio</a>
<p style="margin:12px 0 0;color:var(--mut);font-size:14px">Or copy this link into Stremio → Addons → search box:</p><code id="link"></code></div>
</section>

<section><h2>How it works</h2><ol>
<li>When you open a movie or episode, the addon picks the best English subtitles from OpenSubtitles.</li>
<li>Your AI translates them in about 30 seconds. The first option starts right away.</li>
<li>If it is still translating, the subtitle says so. Open it again in a moment.</li>
<li>Finished translations are shared, so popular titles are often instant and free.</li>
</ol></section>

<section><h2>Notice</h2><ul>
<li>This addon only translates subtitle text. It does not host, link or stream any video.</li>
<li>Source subtitles come from OpenSubtitles. Translations are made by the AI you choose, on your account.</li>
<li>Machine translation can be wrong. No warranty.</li>
</ul></section>
</main>
<script>
const $ = id => document.getElementById(id);
const DEFAULTS = ${JSON.stringify(defaults)};
const PREV = ${JSON.stringify(token || '')};
let lastDefault = $('m').value ? null : DEFAULTS[$('p').value];
if (!$('m').value) $('m').value = DEFAULTS[$('p').value] || '';
$('p').onchange = () => {
  $('uwrap').classList.toggle('hide', $('p').value !== 'custom');
  if (!$('m').value || $('m').value === lastDefault) $('m').value = lastDefault = DEFAULTS[$('p').value] || '';
  $('models').innerHTML = '';
};
const body = () => JSON.stringify({ p: $('p').value, k: $('k').value, m: $('m').value, u: $('u').value, l: $('l').value, n: Number($('n').value), prev: PREV });
const show = (el, ok, text) => { el.className = 'msg ' + (ok ? 'ok' : 'bad'); el.textContent = text; };
async function call(path, btn) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = '…';
  try { const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body() }); return await r.json(); }
  catch (e) { return { error: 'Network error. Try again.' }; }
  finally { btn.disabled = false; btn.textContent = label; }
}
$('load').onclick = async () => {
  const r = await call('${esc(PUBLIC_URL)}/api/models', $('load'));
  if (r.error) return show($('testmsg'), false, r.error);
  $('models').innerHTML = r.models.map(m => '<option value="' + m.replace(/"/g, '&quot;') + '">').join('');
  show($('testmsg'), true, r.models.length + ' models found. Tap the model field to pick one.');
};
$('test').onclick = async () => {
  const r = await call('${esc(PUBLIC_URL)}/api/test', $('test'));
  show($('testmsg'), !r.error, r.error || ('It works: "' + r.sample + '"'));
};
$('save').onclick = async () => {
  const r = await call('${esc(PUBLIC_URL)}/api/config', $('save'));
  if (r.error) { $('out').classList.remove('on'); return show($('savemsg'), false, r.error); }
  $('savemsg').className = 'msg';
  $('open').href = r.stremio; $('link').textContent = r.manifest; $('out').classList.add('on');
  location.href = r.stremio;
};
</script></body></html>`;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 20000) throw new Error('too large'); }
  return JSON.parse(body || '{}');
}

// builds the config from the form; an empty key reuses the one from the previous install
function configFromForm(f) {
  const prev = f.prev ? openConfig(String(f.prev)) : null;
  const k = String(f.k || '').trim() || (prev && prev.p === f.p ? prev.k : '');
  return validConfig({ ...f, k }, true);
}

async function handleApi(req, res, name) {
  let f;
  try { f = await readJson(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
  let cfg;
  try { cfg = configFromForm({ ...f, l: f.l || 'pob' }); } catch (e) { return send(res, 200, { error: e.message }); }
  try {
    if (name === 'config') {
      const token = sealConfig(cfg);
      const manifest = `${PUBLIC_URL}/${token}/manifest.json`;
      log(`install ${cfg.p}/${cfg.m} → ${cfg.l} x${cfg.n}`);
      return send(res, 200, { manifest, stremio: manifest.replace(/^https?:\/\//, 'stremio://') });
    }
    if (name === 'models') return send(res, 200, { models: await listModels(cfg) });
    if (name === 'test') {
      const out = await chat(cfg, systemPrompt(cfg.l, null), JSON.stringify({ 0: 'Hey, are you okay? The ambulance is on its way.' }), 45000);
      const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
      if (typeof json[0] !== 'string') throw new Error('the model did not answer in the expected format');
      return send(res, 200, { sample: json[0] });
    }
  } catch (e) {
    return send(res, 200, { error: `Failed: ${friendlyError(e)}.` });
  }
  send(res, 404, { error: 'not found' });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const url = new URL(req.url, 'http://x');
    // accept with or without the prefix (the proxy may pass the full path)
    let p = url.pathname;
    if (BASE_PATH && (p === BASE_PATH || p.startsWith(`${BASE_PATH}/`))) p = p.slice(BASE_PATH.length) || '/';
    const html = 'text/html; charset=utf-8';

    if (p === '/health') return send(res, 200, { ok: true, jobs: jobs.size });
    if (p === '/' ) return send(res, 302, '', 'text/plain', { Location: `${PUBLIC_URL}/configure` });
    if (p === '/configure') return send(res, 200, configurePage(null, ''), html);
    if (p === '/manifest.json') {
      return send(res, 200, { ...manifestBase, behaviorHints: { configurable: true, configurationRequired: true } });
    }
    let m = p.match(/^\/api\/(config|models|test)$/);
    if (m && req.method === 'POST') return handleApi(req, res, m[1]);

    // from here on: /{config}/...
    m = p.match(/^\/([A-Za-z0-9_-]{40,})(\/.*)$/);
    if (!m) return send(res, 404, { error: 'not found' });
    const [, token, rest] = m;
    const cfg = openConfig(token);
    if (!cfg) {
      if (rest === '/configure') return send(res, 302, '', 'text/plain', { Location: `${PUBLIC_URL}/configure` });
      return send(res, 404, { error: 'invalid configuration, reinstall the addon' });
    }

    if (rest === '/manifest.json') {
      const L = LANG[cfg.l];
      return send(res, 200, { ...manifestBase, description: `${manifestBase.description} Translating into ${L.name}.`, behaviorHints: { configurable: true } });
    }
    if (rest === '/configure') return send(res, 200, configurePage(cfg, token), html);

    // /subtitles/{type}/{id}.json  or  /subtitles/{type}/{id}/{extra}.json
    m = rest.match(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\/(.+))?\.json$/);
    if (m) {
      const subtitles = await handleSubtitles(cfg, token, m[1], decodeURIComponent(m[2]), m[3], ip);
      return send(res, 200, { subtitles, cacheMaxAge: 0 });
    }

    m = rest.match(/^\/sub\/([\w-]+)\/([\w-]+)\.srt$/);
    if (m) return serveSub(res, cfg, m[1], m[2], ip);

    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error:', e.message);
    send(res, 500, { error: 'internal error' });
  }
});

if (SECRET.length < 32) { console.error('CONFIG_SECRET missing or too short (min 32 chars)'); process.exit(1); }
cleanCache();
setInterval(cleanCache, 6 * 3600000).unref();
setInterval(() => { const now = Date.now(); for (const [ip, l] of ipJobs) if (!l.some(t => now - t < 3600000)) ipJobs.delete(ip); }, 600000).unref();
server.listen(PORT, HOST, () => log(`AI Subtitles on ${PUBLIC_URL}/configure`));

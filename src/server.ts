import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import nodemailer from 'nodemailer';

/* ---------- Configuration ---------- */
const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? './data/bionical.db';
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? join(process.cwd(), 'public');
const SECURE = process.env.COOKIE_SECURE !== 'false'; // false uniquement en HTTP local
const COOKIE = SECURE ? '__Host-bsid' : 'bsid';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_MEMBERS = 50;
const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const MAIL_FROM = process.env.MAIL_FROM ?? 'Bionical <no-reply@bionical.com>';
const CONTACT_TO = process.env.CONTACT_TO ?? '';

const DEFAULTS = { theme: 'auto', model: 'qwen2.5-coder:7b', ctx: '8192', wifi: true, use: false };

/* ---------- Base de données (SQLite, fichier local) ---------- */
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_salt BLOB NOT NULL,
  pw_hash BLOB NOT NULL,
  plan TEXT NOT NULL DEFAULT 'Local',
  settings TEXT NOT NULL,
  team_name TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  PRIMARY KEY(user_id, email)
);
CREATE TABLE IF NOT EXISTS contacts(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS password_resets(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
`);

type User = {
  id: number; email: string; name: string; pw_salt: Buffer; pw_hash: Buffer;
  plan: string; settings: string; team_name: string; created: number;
};

/* ---------- Utilitaires ---------- */
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const isUnique = (e: unknown) => (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';

const hashPw = (pw: string, salt: Buffer) =>
  new Promise<Buffer>((res, rej) =>
    scryptCb(pw.normalize('NFKC'), salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (e, k) =>
      e ? rej(e) : res(k),
    ),
  );

const hits = new Map<string, { n: number; t: number }>();
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.t > windowMs) {
    hits.set(key, { n: 1, t: now });
    return false;
  }
  return ++h.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (now - h.t > 3600e3) hits.delete(k);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
  db.prepare('DELETE FROM password_resets WHERE expires < ?').run(now);
}, 3600e3).unref();

/* ---------- Validation ---------- */
const email = z.string().trim().toLowerCase().email('Adresse e‑mail invalide.').max(254, 'Adresse e‑mail invalide.');
const name = z.string().trim().min(1, 'Le nom est obligatoire.').max(80, 'Le nom est trop long.');
const password = z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères.').max(200);
const SignUp = z.object({ name, email, password });
const Login = z.object({ email, password: z.string().min(1).max(200) });
const Profile = z.object({ name, email });
const Settings = z.object({
  theme: z.enum(['auto', 'light', 'dark']),
  model: z.enum(['llama3.2:3b', 'qwen2.5-coder:7b', 'mistral:7b', 'phi3.5:mini']),
  ctx: z.enum(['4096', '8192', '32768']),
  wifi: z.boolean(),
  use: z.boolean(),
});
const Team = z.object({ name });
const Member = z.object({ email });
const Delete = z.object({ confirm: email });
const Contact = z.object({
  name, email,
  subject: z.string().trim().max(80),
  message: z.string().trim().min(1, 'Le message est vide.').max(5000, 'Le message est trop long.'),
});

const Forgot = z.object({ email });
const Reset = z.object({ token: z.string().min(20).max(100), password });
const ChangePw = z.object({ current: z.string().min(1).max(200), password });

/* ---------- Sessions ---------- */
function startSession(userId: number, reply: FastifyReply) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash, user_id, expires) VALUES (?,?,?)').run(sha(token), userId, Date.now() + SESSION_MS);
  reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: SECURE, path: '/', maxAge: SESSION_MS / 1000 });
}

function currentUser(req: FastifyRequest): User | null {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const row = db
    .prepare('SELECT u.*, s.expires AS s_exp FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
    .get(sha(token)) as (User & { s_exp: number }) | undefined;
  if (!row) return null;
  if (row.s_exp < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
    return null;
  }
  return row;
}

const need = (req: FastifyRequest): User => {
  const u = currentUser(req);
  if (!u) throw fail(401, 'Vous n’êtes pas connecté.');
  return u;
};

function pub(userId: number) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User;
  const members = (db.prepare('SELECT email FROM team_members WHERE user_id = ? ORDER BY rowid').all(userId) as { email: string }[]).map((r) => r.email);
  return {
    name: u.name, email: u.email, plan: u.plan, created: u.created,
    settings: { ...DEFAULTS, ...JSON.parse(u.settings) },
    team: { name: u.team_name, members },
  };
}

/* ---------- Application ---------- */
const app = Fastify({ trustProxy: process.env.TRUST_PROXY === 'true', logger: true });
await app.register(cookie);

app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/api/') && req.method !== 'GET' && req.method !== 'HEAD') {
    // Protection CSRF : en-tête personnalisé (impossible cross-origin sans CORS) + contrôle d'origine
    if (req.headers['x-bionical'] !== '1') return reply.code(403).send({ error: 'Requête refusée.' });
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* origine invalide */ }
      if (host !== req.headers.host) return reply.code(403).send({ error: 'Requête refusée.' });
    }
  }
});

app.addHook('onSend', async (req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  if (SECURE) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  return payload;
});

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues[0]?.message ?? 'Données invalides.' });
  const code = err.statusCode ?? 500;
  if (code >= 500) app.log.error(err);
  return reply.code(code).send({ error: code >= 500 ? 'Erreur serveur.' : err.message });
});
app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Introuvable.' }));

/* Fichiers du site */
const assets: Record<string, { file: string; type: string; cache: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=300' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8', cache: 'public, max-age=300' },
};
for (const [path, a] of Object.entries(assets)) {
  const body = readFileSync(join(PUBLIC_DIR, a.file));
  app.get(path, async (_req, reply) => reply.type(a.type).header('Cache-Control', a.cache).send(body));
}

app.get('/api/health', async () => ({ ok: true }));

/* E-mail (SMTP auto-hébergé). Sans SMTP_URL, le message est écrit dans les journaux (développement). */
const mailer = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
async function sendMail(to: string, subject: string, text: string, replyTo?: string) {
  if (!mailer) {
    app.log.warn({ to, subject, text }, 'SMTP_URL non défini : e‑mail écrit ici au lieu d’être envoyé');
    return;
  }
  try {
    await mailer.sendMail({ from: MAIL_FROM, to, subject, text, replyTo });
  } catch (e) {
    app.log.error(e, 'Échec d’envoi d’e‑mail');
  }
}

/* Authentification */
app.post('/api/auth/signup', async (req, reply) => {
  if (limited('signup:' + req.ip, 10, 3600e3)) throw fail(429, 'Trop de tentatives. Réessayez plus tard.');
  const b = SignUp.parse(req.body);
  const salt = randomBytes(16);
  const hash = await hashPw(b.password, salt);
  try {
    const r = db
      .prepare('INSERT INTO users(email, name, pw_salt, pw_hash, settings, created) VALUES (?,?,?,?,?,?)')
      .run(b.email, b.name, salt, hash, JSON.stringify(DEFAULTS), Date.now());
    const id = Number(r.lastInsertRowid);
    startSession(id, reply);
    return reply.code(201).send(pub(id));
  } catch (e) {
    if (isUnique(e)) throw fail(409, 'Un compte existe déjà avec cet e‑mail. Connectez-vous.');
    throw e;
  }
});

app.post('/api/auth/login', async (req, reply) => {
  if (limited('login:' + req.ip, 10, 15 * 60e3)) throw fail(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
  const b = Login.parse(req.body);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(b.email) as User | undefined;
  const h = await hashPw(b.password, u?.pw_salt ?? randomBytes(16)); // même coût si le compte n'existe pas
  if (!u || !timingSafeEqual(h, u.pw_hash)) throw fail(401, 'E‑mail ou mot de passe incorrect.');
  startSession(u.id, reply);
  return pub(u.id);
});

app.post('/api/auth/logout', async (req, reply) => {
  const token = req.cookies[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  reply.clearCookie(COOKIE, { path: '/', secure: SECURE, httpOnly: true, sameSite: 'lax' });
  return { ok: true };
});

app.post('/api/auth/forgot', async (req) => {
  if (limited('forgot:' + req.ip, 5, 3600e3)) throw fail(429, 'Trop de demandes. Réessayez plus tard.');
  const b = Forgot.parse(req.body);
  const u = db.prepare('SELECT id, email FROM users WHERE email = ?').get(b.email) as { id: number; email: string } | undefined;
  if (u) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id);
    db.prepare('INSERT INTO password_resets(token_hash, user_id, expires) VALUES (?,?,?)').run(sha(token), u.id, Date.now() + 3600e3);
    void sendMail(
      u.email,
      'Réinitialisation de votre mot de passe Bionical',
      `Bonjour,\n\nPour choisir un nouveau mot de passe, ouvrez ce lien (valable 1 heure) :\n${BASE_URL}/#reinitialiser/${token}\n\nSi vous n’avez pas fait cette demande, ignorez ce message.`,
    );
  }
  return { ok: true }; // même réponse que le compte existe ou non
});

app.post('/api/auth/reset', async (req) => {
  if (limited('reset:' + req.ip, 10, 3600e3)) throw fail(429, 'Trop de tentatives. Réessayez plus tard.');
  const b = Reset.parse(req.body);
  const r = db.prepare('SELECT user_id, expires FROM password_resets WHERE token_hash = ?').get(sha(b.token)) as
    | { user_id: number; expires: number }
    | undefined;
  if (!r || r.expires < Date.now()) throw fail(400, 'Ce lien est invalide ou a expiré. Refaites une demande.');
  const salt = randomBytes(16);
  const hash = await hashPw(b.password, salt);
  db.transaction(() => {
    db.prepare('UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?').run(salt, hash, r.user_id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(r.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user_id); // déconnecte tous les appareils
  })();
  return { ok: true };
});

app.post('/api/me/password', async (req) => {
  const u = need(req);
  if (limited('pw:' + u.id, 10, 15 * 60e3)) throw fail(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
  const b = ChangePw.parse(req.body);
  const cur = await hashPw(b.current, u.pw_salt);
  if (!timingSafeEqual(cur, u.pw_hash)) throw fail(400, 'Le mot de passe actuel est incorrect.');
  const salt = randomBytes(16);
  const hash = await hashPw(b.password, salt);
  db.prepare('UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?').run(salt, hash, u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(u.id, sha(req.cookies[COOKIE] ?? '')); // garde la session courante
  return { ok: true };
});

/* Profil, paramètres, suppression */
app.get('/api/me', async (req) => pub(need(req).id));

app.patch('/api/me', async (req) => {
  const u = need(req);
  const b = Profile.parse(req.body);
  try {
    db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(b.name, b.email, u.id);
  } catch (e) {
    if (isUnique(e)) throw fail(409, 'Cet e‑mail est déjà utilisé par un autre compte.');
    throw e;
  }
  return pub(u.id);
});

app.put('/api/me/settings', async (req) => {
  const u = need(req);
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(Settings.parse(req.body)), u.id);
  return pub(u.id);
});

app.delete('/api/me', async (req, reply) => {
  const u = need(req);
  const b = Delete.parse(req.body);
  if (b.confirm !== u.email) throw fail(400, 'L’e‑mail saisi ne correspond pas à votre compte.');
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id); // supprime aussi sessions et membres (ON DELETE CASCADE)
  reply.clearCookie(COOKIE, { path: '/', secure: SECURE, httpOnly: true, sameSite: 'lax' });
  return { ok: true };
});

/* Équipe */
app.put('/api/team', async (req) => {
  const u = need(req);
  db.prepare('UPDATE users SET team_name = ? WHERE id = ?').run(Team.parse(req.body).name, u.id);
  return pub(u.id);
});

app.post('/api/team/members', async (req) => {
  const u = need(req);
  const b = Member.parse(req.body);
  const n = (db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE user_id = ?').get(u.id) as { n: number }).n;
  if (n >= MAX_MEMBERS) throw fail(400, `Une équipe est limitée à ${MAX_MEMBERS} membres.`);
  db.prepare('INSERT OR IGNORE INTO team_members(user_id, email) VALUES (?,?)').run(u.id, b.email);
  return pub(u.id);
});

app.delete('/api/team/members/:email', async (req) => {
  const u = need(req);
  const e = String((req.params as { email: string }).email).trim().toLowerCase();
  db.prepare('DELETE FROM team_members WHERE user_id = ? AND email = ?').run(u.id, e);
  return pub(u.id);
});

/* Contact */
app.post('/api/contact', async (req) => {
  if (limited('contact:' + req.ip, 5, 3600e3)) throw fail(429, 'Trop de messages. Réessayez plus tard.');
  const b = Contact.parse(req.body);
  db.prepare('INSERT INTO contacts(name, email, subject, message, created) VALUES (?,?,?,?,?)').run(b.name, b.email, b.subject, b.message, Date.now());
  if (CONTACT_TO) void sendMail(CONTACT_TO, `[Contact] ${b.subject || 'Sans sujet'}`, `${b.name} <${b.email}>\n\n${b.message}`, b.email);
  return { ok: true };
});

/* ---------- Démarrage ---------- */
await app.listen({ port: PORT, host: '0.0.0.0' });
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}

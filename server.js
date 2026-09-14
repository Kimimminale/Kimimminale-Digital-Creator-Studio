'use strict';

/**
 * VideoFlow backend: OAuth secrets/tokens are exclusively server-side.
 * For production, swap JsonDatabase/LocalObjectStorage for Postgres/S3 and run
 * the queue in a dedicated worker process with a durable queue such as BullMQ.
 */
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

loadEnv(path.join(__dirname, '.env'));
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'studio.json');
const VIDEO_DIR = path.join(ROOT, 'storage', 'videos');
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const TOKEN_KEY = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.TOKEN_ENCRYPTION_KEY || !process.env.SESSION_SECRET) console.warn('CẢNH BÁO: dùng khóa phiên/mã hóa tạm thời; hãy đặt TOKEN_ENCRYPTION_KEY và SESSION_SECRET trước khi triển khai.');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

const PLATFORM_CONFIG = {
  YouTube: { env: 'YOUTUBE', authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scopes: ['https://www.googleapis.com/auth/youtube.upload'], publishUrl: 'https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status', content: ['video'] },
  TikTok: { env: 'TIKTOK', authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/', tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/', scopes: ['video.publish'], publishUrl: 'https://open.tiktokapis.com/v2/post/publish/video/init/', content: ['video'] },
  Instagram: { env: 'INSTAGRAM', authorizeUrl: 'https://www.instagram.com/oauth/authorize', tokenUrl: 'https://api.instagram.com/oauth/access_token', scopes: ['instagram_business_basic', 'instagram_business_content_publish'], publishUrl: 'https://graph.facebook.com/v21.0/{accountId}/media', content: ['reel'] },
  Facebook: { env: 'FACEBOOK', authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth', tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token', scopes: ['pages_manage_posts', 'pages_read_engagement'], publishUrl: 'https://graph.facebook.com/v21.0/{accountId}/videos', content: ['video', 'reel'] },
};

class JsonDatabase {
  constructor(file) { this.file = file; this.data = { campaigns: [], videos: [], connections: [], jobs: [], logs: [] }; this.writing = Promise.resolve(); }
  async init() { await fs.mkdir(path.dirname(this.file), { recursive: true }); try { this.data = { ...this.data, ...JSON.parse(await fs.readFile(this.file, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; await this.save(); } }
  async save() { this.writing = this.writing.then(() => fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')); return this.writing; }
  async insert(collection, item) { this.data[collection].push(item); await this.save(); return item; }
  async update(collection, id, changes) { const item = this.data[collection].find((entry) => entry.id === id); if (!item) return null; Object.assign(item, changes, { updatedAt: new Date().toISOString() }); await this.save(); return item; }
}

class LocalObjectStorage {
  async put(file) { await fs.mkdir(VIDEO_DIR, { recursive: true }); const extension = path.extname(file.name).toLowerCase() || '.mp4'; const key = `${crypto.randomUUID()}${extension}`; await fs.writeFile(path.join(VIDEO_DIR, key), file.buffer, { flag: 'wx' }); return { key, url: `/api/videos/${key}` }; }
  async get(key) { return fs.readFile(path.join(VIDEO_DIR, path.basename(key))); }
}

const db = new JsonDatabase(DATA_FILE);
const storage = new LocalObjectStorage();
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const platformList = () => Object.entries(PLATFORM_CONFIG).map(([name, config]) => ({ name, connected: Boolean(db.data.connections.find((item) => item.platform === name && item.status === 'connected')), supportedContent: config.content }));

function encrypt(plainText) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(TOKEN_KEY, 'hex'), iv); const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]); return { ciphertext: encrypted.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }; }
function decrypt(value) { const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(TOKEN_KEY, 'hex'), Buffer.from(value.iv, 'base64')); decipher.setAuthTag(Buffer.from(value.tag, 'base64')); return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8'); }
function hmac(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url'); }
function cookieSession(req) { const raw = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('vf_session='))?.slice(11); if (!raw) return null; const [payload, signature] = raw.split('.'); const expected = payload ? hmac(payload) : ''; if (!payload || !signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null; try { return JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; } }
function setSession(res, session) { const payload = Buffer.from(JSON.stringify(session)).toString('base64url'); res.setHeader('Set-Cookie', `vf_session=${payload}.${hmac(payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`); }
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); res.end(JSON.stringify(value)); }
function text(res, status, value) { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(value); }
async function requestBody(req, maxBytes = MAX_UPLOAD_BYTES) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new Error('Tệp vượt quá giới hạn 2GB.'); chunks.push(chunk); } return Buffer.concat(chunks); }
function requireSameOrigin(req, url) { const origin = req.headers.origin; return !origin || origin === `${url.protocol}//${url.host}`; }
function log(campaignId, level, message, platform) { return db.insert('logs', { id: id(), campaignId, platform, level, message, createdAt: now() }); }

async function refreshToken(connection) {
  if (!connection.refreshToken || !connection.tokenExpiresAt || new Date(connection.tokenExpiresAt) > new Date(Date.now() + 60_000)) return connection;
  const config = PLATFORM_CONFIG[connection.platform]; const prefix = config.env;
  const response = await fetch(config.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decrypt(connection.refreshToken), client_id: process.env[`${prefix}_CLIENT_ID`], client_secret: process.env[`${prefix}_CLIENT_SECRET`] }) });
  if (!response.ok) throw new Error(`Không thể làm mới token ${connection.platform}.`);
  const token = await response.json(); return db.update('connections', connection.id, { accessToken: encrypt(token.access_token), refreshToken: token.refresh_token ? encrypt(token.refresh_token) : connection.refreshToken, tokenExpiresAt: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString() });
}

async function publishJob(job) {
  const campaign = db.data.campaigns.find((entry) => entry.id === job.campaignId); const video = db.data.videos.find((entry) => entry.id === campaign.videoId); let connection = db.data.connections.find((entry) => entry.platform === job.platform && entry.status === 'connected');
  if (!campaign || !video) throw new Error('Không tìm thấy dữ liệu chiến dịch hoặc video.');
  if (!connection) throw new Error(`Chưa kết nối OAuth cho ${job.platform}.`);
  connection = await refreshToken(connection);
  // Platform-specific upload adapters belong here. Only the server decrypts the token.
  // A production adapter uploads the stored object and then creates the platform post.
  const endpoint = PLATFORM_CONFIG[job.platform].publishUrl.replace('{accountId}', connection.accountId || 'me');
  if (!process.env[`${PLATFORM_CONFIG[job.platform].env}_CLIENT_ID`]) throw new Error(`${job.platform} chưa được cấu hình credentials trên máy chủ.`);
  await log(campaign.id, 'info', `Đã gửi tác vụ xuất bản tới ${job.platform} (${endpoint}).`, job.platform);
  // Do not pretend to publish: provider-specific multipart/resumable upload must be implemented and tested per platform.
  throw new Error(`Trình kết nối ${job.platform} cần hoàn tất quy trình upload API của nền tảng trước khi có thể xuất bản.`);
}

async function processQueue() { const due = db.data.jobs.filter((job) => job.status === 'queued' && new Date(job.runAt) <= new Date()); for (const job of due) { await db.update('jobs', job.id, { status: 'running', startedAt: now() }); try { await publishJob(job); await db.update('jobs', job.id, { status: 'completed', completedAt: now() }); await log(job.campaignId, 'success', `Đã xuất bản thành công lên ${job.platform}.`, job.platform); } catch (error) { const attempts = job.attempts + 1; const retryable = attempts < 3; await db.update('jobs', job.id, { status: retryable ? 'queued' : 'failed', attempts, runAt: retryable ? new Date(Date.now() + 2 ** attempts * 60_000).toISOString() : job.runAt, error: error.message }); await log(job.campaignId, retryable ? 'warning' : 'error', `${error.message}${retryable ? ` Sẽ thử lại lần ${attempts + 1}.` : ''}`, job.platform); } const jobs = db.data.jobs.filter((entry) => entry.campaignId === job.campaignId); await db.update('campaigns', job.campaignId, { status: jobs.some((entry) => entry.status === 'failed') ? 'failed' : jobs.some((entry) => entry.status !== 'completed') ? 'scheduled' : 'published' }); } }

async function serveStatic(res, pathname) { const files = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' }; const file = files[pathname]; if (!file) return false; const contentType = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8'; res.writeHead(200, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:" }); res.end(await fs.readFile(path.join(ROOT, file))); return true; }

const server = http.createServer(async (req, res) => { try { const url = new URL(req.url, PUBLIC_BASE_URL); const session = cookieSession(req); if (!session) setSession(res, { userId: 'kim-immina', createdAt: now() });
  if (req.method === 'GET' && await serveStatic(res, url.pathname)) return;
  if (url.pathname.startsWith('/api/videos/') && req.method === 'GET') { const bytes = await storage.get(url.pathname.slice(12)); res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length, 'Accept-Ranges': 'bytes' }); res.end(bytes); return; }
  if (!url.pathname.startsWith('/api/')) return text(res, 404, 'Không tìm thấy trang.');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !requireSameOrigin(req, url)) return json(res, 403, { error: 'Origin không hợp lệ.' });
  if (req.method === 'GET' && url.pathname === '/api/dashboard') return json(res, 200, { platforms: platformList(), campaigns: db.data.campaigns.slice(-8).reverse(), logs: db.data.logs.slice(-20).reverse() });
  if (req.method === 'POST' && url.pathname === '/api/videos') { const name = decodeURIComponent(req.headers['x-file-name'] || 'video.mp4'); const type = req.headers['content-type'] || ''; if (!type.startsWith('video/')) return json(res, 400, { error: 'Chỉ chấp nhận tệp video.' }); const buffer = await requestBody(req); const object = await storage.put({ name, buffer }); const video = await db.insert('videos', { id: id(), name: path.basename(name), mimeType: type, bytes: buffer.length, storageKey: object.key, storageUrl: object.url, createdAt: now() }); return json(res, 201, { video: { id: video.id, name: video.name, bytes: video.bytes } }); }
  if (req.method === 'POST' && url.pathname === '/api/campaigns') { const body = JSON.parse((await requestBody(req, 100_000)).toString() || '{}'); const title = String(body.title || '').trim(); const description = String(body.description || '').trim(); const platforms = Array.isArray(body.platforms) ? body.platforms.filter((item) => PLATFORM_CONFIG[item]) : []; const video = db.data.videos.find((item) => item.id === body.videoId); const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : new Date(); if (!title || !video || !platforms.length || Number.isNaN(scheduledAt.valueOf())) return json(res, 400, { error: 'Thiếu tiêu đề, video, nền tảng hoặc thời gian đăng hợp lệ.' }); const campaign = await db.insert('campaigns', { id: id(), title, description, videoId: video.id, platforms, scheduledAt: scheduledAt.toISOString(), status: 'scheduled', createdAt: now() }); for (const platform of platforms) await db.insert('jobs', { id: id(), campaignId: campaign.id, platform, status: 'queued', attempts: 0, runAt: campaign.scheduledAt, createdAt: now() }); await log(campaign.id, 'info', `Đã tạo chiến dịch và xếp hàng cho ${platforms.join(', ')}.`); return json(res, 201, { campaign }); }
  const oauth = url.pathname.match(/^\/api\/oauth\/([^/]+)\/(start|callback)$/); if (oauth) { const platform = Object.keys(PLATFORM_CONFIG).find((item) => item.toLowerCase() === oauth[1].toLowerCase()); if (!platform) return json(res, 404, { error: 'Nền tảng không hỗ trợ.' }); const config = PLATFORM_CONFIG[platform]; const prefix = config.env; if (oauth[2] === 'start') { if (!process.env[`${prefix}_CLIENT_ID`]) return json(res, 503, { error: `${platform} chưa được cấu hình OAuth trên máy chủ.` }); const state = crypto.randomBytes(24).toString('base64url'); const verifier = crypto.randomBytes(48).toString('base64url'); setSession(res, { userId: 'kim-immina', oauth: { state, verifier, platform, expiresAt: Date.now() + 600_000 } }); const authorization = new URL(config.authorizeUrl); authorization.search = new URLSearchParams({ client_id: process.env[`${prefix}_CLIENT_ID`], redirect_uri: `${PUBLIC_BASE_URL}/api/oauth/${platform.toLowerCase()}/callback`, response_type: 'code', scope: config.scopes.join(' '), state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }); res.writeHead(302, { Location: authorization }); return res.end(); } const active = session?.oauth; if (!active || active.platform !== platform || active.state !== url.searchParams.get('state') || active.expiresAt < Date.now()) return json(res, 400, { error: 'Phiên OAuth không hợp lệ hoặc đã hết hạn.' }); const code = url.searchParams.get('code');
    if (!code) return json(res, 400, { error: `Không nhận được mã cấp quyền từ ${platform}.` });
    const tokenResponse = await fetch(config.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: process.env[`${prefix}_CLIENT_ID`], client_secret: process.env[`${prefix}_CLIENT_SECRET`], redirect_uri: `${PUBLIC_BASE_URL}/api/oauth/${platform.toLowerCase()}/callback`, grant_type: 'authorization_code', code_verifier: active.verifier }) });
    if (!tokenResponse.ok) return json(res, 502, { error: `Không thể đổi mã OAuth của ${platform} thành token.` });
    const token = await tokenResponse.json();
    if (!token.access_token) return json(res, 502, { error: `${platform} không trả về access token.` });
    const existing = db.data.connections.find((item) => item.platform === platform);
    const connection = { id: existing?.id || id(), platform, status: 'connected', accountId: token.open_id || token.user_id || token.id || null, accessToken: encrypt(token.access_token), refreshToken: token.refresh_token ? encrypt(token.refresh_token) : existing?.refreshToken || null, tokenExpiresAt: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(), scopes: config.scopes, createdAt: existing?.createdAt || now() };
    if (existing) await db.update('connections', existing.id, connection); else await db.insert('connections', connection);
    await log(null, 'success', `Đã kết nối OAuth với ${platform}.`, platform);
    res.writeHead(302, { Location: '/#connections' }); return res.end(); }
  return json(res, 404, { error: 'Không tìm thấy API.' });
 } catch (error) { console.error(error); return json(res, error.message.includes('giới hạn') ? 413 : 500, { error: error.message || 'Lỗi máy chủ.' }); } });

db.init().then(() => { server.listen(PORT, () => console.log(`VideoFlow chạy tại ${PUBLIC_BASE_URL}`)); setInterval(() => processQueue().catch(console.error), 15_000).unref(); processQueue().catch(console.error); });
function loadEnv(file) { try { for (const line of require('node:fs').readFileSync(file, 'utf8').split(/\r?\n/)) { const match = line.match(/^\s*([A-Z0-9_]+)=(.*)$/); if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, ''); } } catch {} }

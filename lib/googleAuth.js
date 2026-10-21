// "Sign in with Google" for the whole site, limited to @thelistrealty.com
// accounts. No extra npm packages: it talks to Google's OAuth endpoints
// directly and keeps the login in a signed cookie (nothing stored in the DB).
//
// Needs three environment variables in Render:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  (from Google Cloud Console)
//   SESSION_SECRET                          (any long random text you make up)
// Until all three are set, sign-in is simply OFF and the site works as before,
// so deploying this code first is safe.
//
// Optional: GOOGLE_ALLOWED_DOMAIN (default thelistrealty.com),
//           GOOGLE_REDIRECT_URI (default https://thelistopenhouses.com/auth/callback)
const crypto = require('crypto');

const SESSION_COOKIE = 'tl_session';
const STATE_COOKIE = 'tl_oauth_state';
const SESSION_DAYS = 30;

function allowedDomain() { return (process.env.GOOGLE_ALLOWED_DOMAIN || 'thelistrealty.com').toLowerCase(); }
function redirectUri() { return process.env.GOOGLE_REDIRECT_URI || 'https://thelistopenhouses.com/auth/callback'; }
function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.SESSION_SECRET);
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function sign(payload) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
}

function makeSession(email, name) {
  const body = Buffer.from(JSON.stringify({ email, name, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function readSession(req) {
  if (!isConfigured()) return null;
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw || raw.indexOf('.') < 0) return null;
  const [body, sig] = raw.split('.');
  const expected = sign(body);
  const a = Buffer.from(sig || ''); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!s.exp || s.exp < Date.now()) return null;
    return s;
  } catch (e) { return null; }
}

function cookieOpts(maxAgeMs) {
  return { httpOnly: true, secure: true, sameSite: 'lax', maxAge: maxAgeMs, path: '/' };
}

function safeNext(n) { return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/'; }

// Paths that stay reachable without signing in: the login flow itself, and
// the reminder pinger (which has its own secret). Static files (logo, css)
// are served before this gate runs.
function isOpenPath(p) {
  return p.startsWith('/auth/') || p.startsWith('/internal/reminders/');
}

function requireLogin(req, res, next) {
  if (!isConfigured() || isOpenPath(req.path)) return next();
  const s = readSession(req);
  if (s) { req.user = s; res.locals.user = s; return next(); }
  if (req.method !== 'GET') return res.status(401).send('Please sign in first.');
  return res.redirect('/auth/login?next=' + encodeURIComponent(req.originalUrl));
}

function register(app) {
  app.get('/auth/login', (req, res) => {
    if (!isConfigured()) return res.redirect('/');
    const next = safeNext(req.query.next);
    if (readSession(req)) return res.redirect(next);
    res.render('login', { error: req.query.error || null, next });
  });

  app.get('/auth/google', (req, res) => {
    if (!isConfigured()) return res.redirect('/');
    const state = crypto.randomBytes(16).toString('hex') + '|' + safeNext(req.query.next);
    res.cookie(STATE_COOKIE, state, cookieOpts(10 * 60 * 1000));
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      hd: allowedDomain(),
      prompt: 'select_account',
    });
    res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
  });

  app.get('/auth/callback', async (req, res) => {
    const fail = (msg) => res.redirect('/auth/login?error=' + encodeURIComponent(msg));
    try {
      if (!isConfigured()) return res.redirect('/');
      const saved = parseCookies(req)[STATE_COOKIE];
      res.clearCookie(STATE_COOKIE, { path: '/' });
      if (req.query.error) return fail('Google sign-in was cancelled.');
      if (!saved || !req.query.state || saved !== req.query.state || !req.query.code) {
        return fail('Sign-in expired. Please try again.');
      }
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri(),
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || !tokens.access_token) return fail('Google sign-in failed. Please try again.');
      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: 'Bearer ' + tokens.access_token },
      });
      const info = await infoRes.json();
      const email = String(info.email || '').toLowerCase();
      const domainOk = email.endsWith('@' + allowedDomain()) && String(info.hd || '').toLowerCase() === allowedDomain();
      if (!infoRes.ok || info.email_verified !== true || !domainOk) {
        return fail('Only @' + allowedDomain() + ' accounts can sign in.');
      }
      res.cookie(SESSION_COOKIE, makeSession(email, info.name || email), cookieOpts(SESSION_DAYS * 864e5));
      const next = safeNext(saved.split('|').slice(1).join('|'));
      res.redirect(next);
    } catch (err) {
      console.error('Google sign-in error:', err);
      fail('Something went wrong signing in. Please try again.');
    }
  });

  app.get('/auth/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.redirect('/auth/login');
  });
}

module.exports = { register, requireLogin, isConfigured, readSession, makeSession };

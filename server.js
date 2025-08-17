// server.js (cleaned)

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());

// serve app files and uploads
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- ensure upload folders exist ---
const ensureDir = (p) => { try { fs.mkdirSync(p, { recursive: true }); } catch {} };
ensureDir(path.join(__dirname, 'uploads'));
ensureDir(path.join(__dirname, 'uploads', 'timetables'));
ensureDir(path.join(__dirname, 'uploads', 'wall'));

// --- MySQL pool ---
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || 'Vaidehi@123',   // ⚠️ consider .env
  database: process.env.DB_NAME || 'achievify',
  waitForConnections: true,
  connectionLimit: 10,
});

// --- health check ---
app.get('/api/health', async (_req, res) => {
  try { const c = await pool.getConnection(); await c.ping(); c.release(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- REGISTER ---
app.post('/api/register', async (req, res) => {
  try {
    const { fullName, username, email, phone, password } = req.body || {};
    if (!fullName || !username || !email || !password) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    const conn = await pool.getConnection();
    try {
      const [a] = await conn.execute('SELECT 1 FROM users WHERE username = ? LIMIT 1', [username]);
      if (a.length) return res.status(400).json({ message: 'Username already taken' });
      const [b] = await conn.execute('SELECT 1 FROM users WHERE email = ? LIMIT 1', [email]);
      if (b.length) return res.status(400).json({ message: 'Email already registered' });

      const hash = await bcrypt.hash(password, 10);
      await conn.execute(
        'INSERT INTO users (full_name, username, email, phone, password_hash) VALUES (?,?,?,?,?)',
        [fullName.trim(), username.trim(), email.trim(), phone?.trim() || null, hash]
      );
      res.json({ message: 'Registered' });
    } finally { conn.release(); }
  } catch (e) {
    console.error('REGISTER ERROR:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- LOGIN ---
app.post('/api/login', async (req, res) => {
  try {
    const { userOrEmail, password } = req.body || {};
    if (!userOrEmail || !password)
      return res.status(400).json({ message: 'Missing credentials' });

    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.execute(
        'SELECT id, full_name, username, email, password_hash FROM users WHERE username = ? OR email = ? LIMIT 1',
        [userOrEmail, userOrEmail]
      );
      if (!rows.length) return res.status(400).json({ message: 'User not found' });

      const user = rows[0];
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(400).json({ message: 'Invalid password' });

      res.json({
        message: 'Logged in',
        user: { id: user.id, fullName: user.full_name, username: user.username, email: user.email }
      });
    } finally { conn.release(); }
  } catch (e) {
    console.error('LOGIN ERROR:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

/* ========= TODOS ========= */

// List
app.get('/api/todos', async (req, res) => {
  const userId = Number(req.query.userId);
  const done = req.query.done;
  if (!userId) return res.status(400).json({ message: 'userId is required' });
  try {
    const conn = await pool.getConnection();
    try {
      let sql = 'SELECT id, title, done, created_at, updated_at FROM todos WHERE user_id = ?';
      const params = [userId];
      if (done === '0' || done === '1') { sql += ' AND done = ?'; params.push(Number(done)); }
      sql += ' ORDER BY created_at DESC';
      const [rows] = await conn.execute(sql, params);
      res.json(rows);
    } finally { conn.release(); }
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

// Create
app.post('/api/todos', async (req, res) => {
  const { userId, title } = req.body || {};
  if (!userId || !title) return res.status(400).json({ message: 'userId and title are required' });
  try {
    const conn = await pool.getConnection();
    try {
      const [r] = await conn.execute('INSERT INTO todos (user_id, title) VALUES (?, ?)', [Number(userId), title.trim()]);
      const [rows] = await conn.execute('SELECT id, title, done, created_at, updated_at FROM todos WHERE id = ?', [r.insertId]);
      res.json(rows[0]);
    } finally { conn.release(); }
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

// Update
app.put('/api/todos/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { userId, title, done } = req.body || {};
  if (!id || !userId) return res.status(400).json({ message: 'id and userId required' });
  try {
    const conn = await pool.getConnection();
    try {
      const [own] = await conn.execute('SELECT 1 FROM todos WHERE id=? AND user_id=?', [id, Number(userId)]);
      if (!own.length) return res.status(404).json({ message: 'Todo not found' });

      const fields = []; const params = [];
      if (typeof title === 'string') { fields.push('title = ?'); params.push(title.trim()); }
      if ([0,1,true,false].includes(done)) { fields.push('done = ?'); params.push(done ? 1 : 0); }
      if (!fields.length) return res.status(400).json({ message: 'Nothing to update' });

      params.push(id);
      await conn.execute(`UPDATE todos SET ${fields.join(', ')} WHERE id = ?`, params);
      const [rows] = await conn.execute('SELECT id, title, done, created_at, updated_at FROM todos WHERE id = ?', [id]);
      res.json(rows[0]);
    } finally { conn.release(); }
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

// Delete
app.delete('/api/todos/:id', async (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.query.userId);
  if (!id || !userId) return res.status(400).json({ message: 'id and userId required' });
  try {
    const conn = await pool.getConnection();
    try {
      const [own] = await conn.execute('SELECT 1 FROM todos WHERE id=? AND user_id=?', [id, userId]);
      if (!own.length) return res.status(404).json({ message: 'Todo not found' });
      await conn.execute('DELETE FROM todos WHERE id=?', [id]);
      res.json({ message: 'Deleted' });
    } finally { conn.release(); }
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

/* ========= TIMETABLE UPLOAD ========= */

// Multer for timetables
const ttStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.join(__dirname, 'uploads', 'timetables')),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const clean = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, `${ts}_${clean}`);
  }
});
const ttUpload = multer({
  storage: ttStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpeg|webp)|application\/pdf/.test(file.mimetype);
    cb(ok ? null : new Error('Only PNG/JPEG/WEBP or PDF allowed'));
  }
});

// Get latest
app.get('/api/timetable', async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ message: 'userId required' });
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.execute(
        'SELECT id, title, file_path, mime, uploaded_at FROM timetables WHERE user_id=? ORDER BY uploaded_at DESC LIMIT 1',
        [userId]
      );
      res.json(rows[0] || null);
    } finally { conn.release(); }
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

// Upload/replace
app.post('/api/timetable', ttUpload.single('file'), async (req, res) => {
  try {
    const userId = Number(req.body.userId);
    const title = (req.body.title || '').trim();
    const file = req.file;
    if (!userId || !title || !file) return res.status(400).json({ message: 'userId, title, file required' });

    const relPath = path.join('uploads', 'timetables', file.filename).replace(/\\/g, '/');
    const conn = await pool.getConnection();
    try {
      await conn.execute('INSERT INTO timetables (user_id, title, file_path, mime) VALUES (?,?,?,?)',
        [userId, title, relPath, file.mimetype]);
      const [rows] = await conn.execute(
        'SELECT id, title, file_path, mime, uploaded_at FROM timetables WHERE user_id=? ORDER BY uploaded_at DESC LIMIT 1',
        [userId]
      );
      res.json(rows[0]);
    } finally { conn.release(); }
  } catch (e) { res.status(500).json({ message: e.message || 'Upload error' }); }
});

// Delete current
app.delete('/api/timetable/:id', async (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.query.userId);
  if (!id || !userId) return res.status(400).json({ message: 'id and userId required' });
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.execute('SELECT file_path FROM timetables WHERE id=? AND user_id=? LIMIT 1',[id,userId]);
      if (!rows.length) return res.status(404).json({ message: 'Not found' });
      await conn.execute('DELETE FROM timetables WHERE id=? AND user_id=?', [id,userId]);
      const filePath = rows[0].file_path && path.join(__dirname, rows[0].file_path);
      if (filePath) fs.promises.unlink(filePath).catch(()=>{});
      res.json({ message: 'Deleted' });
    } finally { conn.release(); }
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

/* ========= WEEKLY PLANNER ========= */

app.get('/api/planner', async (req, res) => {
  const userId = Number(req.query.userId);
  const weekKey = (req.query.week || '').trim();
  if (!userId || !weekKey) return res.status(400).json({ message: 'userId and week required' });
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.execute(
        'SELECT data_json, updated_at FROM planner_weeks WHERE user_id=? AND week_key=? LIMIT 1',
        [userId, weekKey]
      );
      if (rows.length) return res.json({ week: weekKey, data: JSON.parse(rows[0].data_json), updated_at: rows[0].updated_at });
      const empty = Array.from({length:3}, ()=> Array.from({length:3}, ()=> ({text:"", color:"#ffffff"})));
      res.json({ week: weekKey, data: empty, updated_at: null });
    } finally { conn.release(); }
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/planner', async (req, res) => {
  const { userId, week, data } = req.body || {};
  if (!userId || !week || !Array.isArray(data) || data.length !== 3) {
    return res.status(400).json({ message: 'userId, week, and 3x3 data required' });
  }
  try {
    const conn = await pool.getConnection();
    try {
      const json = JSON.stringify(data);
      await conn.execute(
        'INSERT INTO planner_weeks (user_id, week_key, data_json) VALUES (?,?,?) ON DUPLICATE KEY UPDATE data_json=VALUES(data_json)',
        [Number(userId), week.trim(), json]
      );
      res.json({ message: 'Saved' });
    } finally { conn.release(); }
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

/* ========= INSPIRATION WALL ========= */

// Multer for wall images
const wallStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.join(__dirname, 'uploads', 'wall')),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const clean = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, `${ts}_${clean}`);
  }
});
const wallUpload = multer({
  storage: wallStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpeg|webp)/.test(file.mimetype);
    cb(ok ? null : new Error('Only PNG/JPEG/WEBP images allowed'));
  }
});

// List wall items
app.get('/api/wall', async (req, res) => {
  const userId = Number(req.query.userId);
  const kind = (req.query.kind || '').trim();
  if (!userId) return res.status(400).json({ message: 'userId required' });
  try {
    const conn = await pool.getConnection();
    try {
      let sql = 'SELECT id, kind, text, author, color, file_path, mime, created_at FROM wall_items WHERE user_id=?';
      const params = [userId];
      if (kind === 'quote' || kind === 'image') { sql += ' AND kind=?'; params.push(kind); }
      sql += ' ORDER BY created_at DESC';
      const [rows] = await conn.execute(sql, params);
      res.json(rows);
    } finally { conn.release(); }
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

// Add quote
app.post('/api/wall/quote', async (req, res) => {
  const { userId, text, author, color } = req.body || {};
  if (!userId || !text) return res.status(400).json({ message: 'userId and text required' });
  try {
    const conn = await pool.getConnection();
    try {
      await conn.execute(
        'INSERT INTO wall_items (user_id, kind, text, author, color) VALUES (?,?,?,?,?)',
        [Number(userId), 'quote', text.trim(), (author||'').trim() || null, (color||'').trim() || null]
      );
      const [rows] = await conn.execute(
        'SELECT id, kind, text, author, color, file_path, mime, created_at FROM wall_items WHERE user_id=? AND kind="quote" ORDER BY created_at DESC LIMIT 1',
        [Number(userId)]
      );
      res.json(rows[0]);
    } finally { conn.release(); }
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

// Add image
app.post('/api/wall/image', wallUpload.single('file'), async (req, res) => {
  const userId = Number(req.body.userId);
  const caption = (req.body.caption || '').trim();
  const file = req.file;
  if (!userId || !file) return res.status(400).json({ message: 'userId and image file required' });
  try {
    const relPath = path.join('uploads', 'wall', file.filename).replace(/\\/g,'/');
    const conn = await pool.getConnection();
    try {
      await conn.execute(
        'INSERT INTO wall_items (user_id, kind, text, file_path, mime) VALUES (?,?,?,?,?)',
        [userId, 'image', caption || null, relPath, file.mimetype]
      );
      const [rows] = await conn.execute(
        'SELECT id, kind, text, author, color, file_path, mime, created_at FROM wall_items WHERE user_id=? AND kind="image" ORDER BY created_at DESC LIMIT 1',
        [userId]
      );
      res.json(rows[0]);
    } finally { conn.release(); }
  } catch (e) { res.status(500).json({ message: e.message || 'Upload error' }); }
});

// Delete item
app.delete('/api/wall/:id', async (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.query.userId);
  if (!id || !userId) return res.status(400).json({ message: 'id and userId required' });
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.execute('SELECT file_path FROM wall_items WHERE id=? AND user_id=? LIMIT 1',[id,userId]);
      if (!rows.length) return res.status(404).json({ message: 'Not found' });
      await conn.execute('DELETE FROM wall_items WHERE id=? AND user_id=?', [id,userId]);
      const fp = rows[0].file_path && path.join(__dirname, rows[0].file_path);
      if (fp) fs.promises.unlink(fp).catch(()=>{});
      res.json({ message: 'Deleted' });
    } finally { conn.release(); }
  } catch (e) { res.status(500).json({ message: 'Server error' }); }
});

const PORT = Number(process.env.PORT || 8081);
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));

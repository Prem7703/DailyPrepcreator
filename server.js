require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET || 'changeme';
const DATA_DIR = '/data';

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

const DB_PATH = path.join(DATA_DIR, 'cyberprep.db');

// ── Middleware ──────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(__dirname));

// ── Uploads dir ─────────────────────────────────────────────────────const uploadDir = path.join('/data', 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ── Database Setup ───────────────────────────────────────────────────
let db;

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}
async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      avatar_color TEXT DEFAULT '#00ff88',
      avatar_url TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      plan_name TEXT NOT NULL,
      description TEXT,
      total_days INTEGER DEFAULT 30,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      day_number INTEGER NOT NULL,
      topic_title TEXT NOT NULL,
      status TEXT DEFAULT 'Not Started',
      subtopics TEXT DEFAULT '[]',
      video_links TEXT DEFAULT '[]',
      pdf_links TEXT DEFAULT '[]',
      notes TEXT DEFAULT '',
      tryhackme_link TEXT DEFAULT '',
      hackviser_link TEXT DEFAULT '',
      tryhackme_done INTEGER DEFAULT 0,
      hackviser_done INTEGER DEFAULT 0,
      progress_percentage INTEGER DEFAULT 0,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS study_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_date DATE NOT NULL,
      count INTEGER DEFAULT 1
    );
  `);

  // 🔥 Ensure avatar_url exists for old databases
  try {
    db.run("ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT NULL");
  } catch (err) {
    // Column already exists — ignore
  }

  saveDb();
}
// ── DB Helpers ───────────────────────────────────────────────────────
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  const lastId = dbGet('SELECT last_insert_rowid() as id');
  saveDb();
  return { lastInsertRowid: lastId ? lastId.id : null };
}

// ── Auth Middleware ──────────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Helper: recalculate topic progress ──────────────────────────────
function recalcProgress(topicId) {
  const topic = dbGet('SELECT * FROM topics WHERE id = ?', [topicId]);
  if (!topic) return null;

  const subtopics = JSON.parse(topic.subtopics || '[]');
  const doneSubs = subtopics.filter(s => s.done).length;
  const totalSubs = subtopics.length;

  const thDone = topic.tryhackme_done ? 1 : 0;
  const hvDone = topic.hackviser_done ? 1 : 0;

  let pct = 0;
  if (totalSubs > 0) pct += (doneSubs / totalSubs) * 60;
  else pct += 60;
  pct += thDone * 20;
  pct += hvDone * 20;
  pct = Math.round(pct);

  let status = 'Not Started';
  if (pct === 100) status = 'Completed';
  else if (pct > 0) status = 'In Progress';

  const isNewlyCompleted = pct === 100 && !topic.completed_at;
  const completedAt = isNewlyCompleted ? new Date().toISOString() : (topic.completed_at || null);

  dbRun('UPDATE topics SET progress_percentage = ?, status = ?, completed_at = ? WHERE id = ?',
    [pct, status, completedAt, topicId]);

  // Log study session
  const today = new Date().toISOString().split('T')[0];
  const existing = dbGet('SELECT * FROM study_sessions WHERE user_id = ? AND session_date = ?', [topic.user_id, today]);
  if (existing) {
    dbRun('UPDATE study_sessions SET count = count + 1 WHERE user_id = ? AND session_date = ?', [topic.user_id, today]);
  } else {
    dbRun('INSERT INTO study_sessions (user_id, session_date, count) VALUES (?, ?, 1)', [topic.user_id, today]);
  }

  const updated = dbGet('SELECT * FROM topics WHERE id = ?', [topicId]);
  return { ...updated, isNewlyCompleted, completedAt };
}

// ── Helper: plan stats ────────────────────────────────────────────────
function getPlanStats(planId) {
  const total = dbGet('SELECT COUNT(*) as c FROM topics WHERE plan_id = ?', [planId]);
  const completed = dbGet("SELECT COUNT(*) as c FROM topics WHERE plan_id = ? AND status = 'Completed'", [planId]);
  const inProgress = dbGet("SELECT COUNT(*) as c FROM topics WHERE plan_id = ? AND status = 'In Progress'", [planId]);
  const t = total ? total.c : 0;
  const c = completed ? completed.c : 0;
  const ip = inProgress ? inProgress.c : 0;
  return {
    total_topics: t,
    completed_topics: c,
    in_progress_topics: ip,
    progress: t > 0 ? Math.round((c / t) * 100) : 0
  };
}

// ── Helper: seed CEH/CNSP plans ──────────────────────────────────────
function seedDefaultPlans(userId) {
  const cehTopics = [
    [1,'Introduction to Ethical Hacking',['Hacking phases','Types of attacks','Legal aspects','Footprinting overview']],
    [2,'Footprinting & Reconnaissance',['Passive reconnaissance','OSINT techniques','Whois/DNS lookups','Google Hacking']],
    [3,'Scanning Networks',['Nmap basics','Port scanning','OS fingerprinting','Vulnerability scanning']],
    [4,'Enumeration',['NetBIOS enumeration','SNMP enumeration','LDAP enumeration','NTP enumeration']],
    [5,'Vulnerability Analysis',['CVE/CVSS','Nessus basics','OpenVAS','Risk rating']],
    [6,'System Hacking',['Password cracking','Privilege escalation','Hiding files','Clearing logs']],
    [7,'Malware Threats',['Virus/Worm/Trojan','Rootkits','Spyware','APT concepts']],
    [8,'Sniffing',['Wireshark basics','ARP poisoning','MAC flooding','Countermeasures']],
    [9,'Social Engineering',['Phishing','Vishing','Baiting','Countermeasures']],
    [10,'Denial of Service',['DoS vs DDoS','Volumetric attacks','Protocol attacks','Botnets']],
    [11,'Session Hijacking',['TCP session hijacking','Cookie theft','MITM attacks','Prevention']],
    [12,'Evading IDS/Firewalls',['IDS evasion techniques','Firewall bypassing','Honeypots','Traffic obfuscation']],
    [13,'Hacking Web Servers',['Web server attacks','Banner grabbing','HTTP response splitting','Countermeasures']],
    [14,'Hacking Web Applications',['OWASP Top 10','SQL Injection','XSS','CSRF']],
    [15,'SQL Injection',['In-band SQLi','Blind SQLi','Error-based SQLi','SQLmap']],
    [16,'Hacking Wireless Networks',['WEP/WPA/WPA2','Evil twin attacks','Deauth attacks','Aircrack-ng']],
    [17,'Hacking Mobile Platforms',['Android security','iOS security','Mobile malware','MDM concepts']],
    [18,'IoT & OT Hacking',['IoT attack surfaces','ICS/SCADA','Shodan','OT security']],
    [19,'Cloud Computing Security',['Cloud models','AWS/Azure/GCP','Cloud attacks','Shared responsibility']],
    [20,'Cryptography',['Encryption algorithms','PKI','Digital signatures','Steganography']],
    [21,'Practice Day - Scanning',['Full Nmap scan lab','Banner grabbing','Scripting with NSE']],
    [22,'Practice Day - Web Hacking',['DVWA labs','Burp Suite basics','Manual SQLi']],
    [23,'Practice Day - System Hacking',['Metasploit framework','Privilege escalation lab']],
    [24,'Practice Day - Wireless',['WPA2 crack lab','Wireshark analysis']],
    [25,'Mock Exam - Part 1',['Chapters 1-10 revision','125 Q practice exam']],
    [26,'Mock Exam - Part 2',['Chapters 11-20 revision','125 Q practice exam']],
    [27,'Weak Area Review',['Identify weak areas','Targeted practice']],
    [28,'Final Lab Day',['TryHackMe rooms','Hackviser labs']],
    [29,'Exam Strategy',['Time management','Question strategies','Last-minute tips']],
    [30,'Exam Day Prep',['Rest and review','Mind map revision','Key concepts recap']],
  ];

  const cnspTopics = [
    [1,'Networking Fundamentals',['OSI model','TCP/IP stack','Subnetting','Common protocols']],
    [2,'Network Security Concepts',['CIA Triad','Defense in depth','Security policies','Risk management']],
    [3,'Firewalls & Packet Filtering',['Stateful vs stateless','Firewall rules','DMZ setup','Next-gen firewalls']],
    [4,'IDS & IPS',['Signature-based detection','Anomaly detection','SNORT basics','Tuning IDS']],
    [5,'VPN Technologies',['IPsec','SSL/TLS VPN','Site-to-site VPN','Remote access VPN']],
    [6,'Network Protocols Security',['DNS security','DHCP snooping','ARP security','BGP security']],
    [7,'Wireless Security',['802.11 standards','WPA3','RADIUS','Wireless monitoring']],
    [8,'Web Security',['HTTP/HTTPS','TLS certificates','WAF concepts','OWASP basics']],
    [9,'Email Security',['SPF/DKIM/DMARC','Email encryption','Phishing protection','Spam filters']],
    [10,'Network Scanning & Enumeration',['Nmap deep dive','Service enumeration','Topology mapping']],
    [11,'Vulnerability Assessment',['Nessus/OpenVAS','CVSS scoring','Patch management','VA reports']],
    [12,'Penetration Testing Basics',['Pen test methodology','Scope & rules','Reporting','Legal aspects']],
    [13,'Password Security',['Password policies','Multi-factor auth','Password managers','Cracking techniques']],
    [14,'Cryptography Essentials',['Symmetric/asymmetric','Hash functions','PKI/CA','Certificate management']],
    [15,'Incident Response',['IR lifecycle','SIEM basics','Log analysis','Forensics intro']],
    [16,'Cloud Security',['Cloud security controls','Shared responsibility','Cloud misconfigs','CASB']],
    [17,'Endpoint Security',['EDR/AV','Host-based firewalls','Application whitelisting','Patch management']],
    [18,'Physical Security',['Physical access controls','CCTV','Tailgating','Clean desk policy']],
    [19,'Security Policies & Compliance',['ISO 27001','NIST framework','GDPR basics','Audit trails']],
    [20,'Threat Intelligence',['IOCs','Threat feeds','MITRE ATT&CK','Threat hunting basics']],
    [21,'Practice - Firewall Labs',['pfSense configuration','Rule writing','Traffic analysis']],
    [22,'Practice - Nmap & Scanning',['Advanced Nmap','NSE scripts','Vulnerability scanning']],
    [23,'Practice - Wireshark',['Packet analysis','Protocol filters','Finding anomalies']],
    [24,'Practice - Web Security',['Burp Suite','Manual testing','Finding vulns']],
    [25,'Mock Exam - Part 1',['Domains 1-10 revision','Practice questions']],
    [26,'Mock Exam - Part 2',['Domains 11-20 revision','Practice questions']],
    [27,'Weak Areas Review',['Identify gaps','Focused study']],
    [28,'Final Labs',['TryHackMe CNSP path','Hackviser labs']],
    [29,'Exam Strategy',['CNSP exam format','Time management','Tips']],
    [30,'Final Revision',['Key concepts recap','Last-minute checklist']],
  ];

  const cehPlan = dbRun('INSERT INTO plans (user_id, plan_name, description, total_days) VALUES (?, ?, ?, ?)',
    [userId, 'CEH', 'Certified Ethical Hacker v13 - 30 Day Roadmap', 30]);

  for (const [day, title, subs] of cehTopics) {
    const subtopics = JSON.stringify(subs.map(s => ({ text: s, done: false })));
    dbRun('INSERT INTO topics (plan_id, user_id, day_number, topic_title, subtopics) VALUES (?, ?, ?, ?, ?)',
      [cehPlan.lastInsertRowid, userId, day, title, subtopics]);
  }

  const cnspPlan = dbRun('INSERT INTO plans (user_id, plan_name, description, total_days) VALUES (?, ?, ?, ?)',
    [userId, 'CNSP', 'Certified Network Security Practitioner - 30 Day Roadmap', 30]);

  for (const [day, title, subs] of cnspTopics) {
    const subtopics = JSON.stringify(subs.map(s => ({ text: s, done: false })));
    dbRun('INSERT INTO topics (plan_id, user_id, day_number, topic_title, subtopics) VALUES (?, ?, ?, ?, ?)',
      [cnspPlan.lastInsertRowid, userId, day, title, subtopics]);
  }
}

// ════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════

// ── Profile Routes ────────────────────────────────────────────────────

// Avatar upload storage
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, 'avatar_' + uuidv4() + path.extname(file.originalname))
});
const avatarUpload = multer({ storage: avatarStorage, limits: { fileSize: 5 * 1024 * 1024 } });

// Upload avatar photo
app.post('/api/auth/avatar', auth, avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const avatarUrl = `/uploads/${req.file.filename}`;

  // Delete old avatar file if exists
  const user = dbGet('SELECT avatar_url FROM users WHERE id = ?', [req.user.id]);
  if (user && user.avatar_url) {
    const oldPath = path.join(__dirname, user.avatar_url);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  dbRun('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, req.user.id]);
  res.json({ avatar_url: avatarUrl });
});

// Update profile (name, email, avatar_color)
app.put('/api/auth/profile', auth, (req, res) => {
  const { name, email, avatar_color } = req.body;
  
  if (email) {
    const existing = dbGet('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id]);
    if (existing) return res.status(400).json({ error: 'Email already in use' });
  }

  if (name) dbRun('UPDATE users SET name = ? WHERE id = ?', [name, req.user.id]);
  if (email) dbRun('UPDATE users SET email = ? WHERE id = ?', [email, req.user.id]);
  if (avatar_color) dbRun('UPDATE users SET avatar_color = ? WHERE id = ?', [avatar_color, req.user.id]);

  const user = dbGet('SELECT id, name, email, avatar_color, avatar_url FROM users WHERE id = ?', [req.user.id]);
  res.json(user);
});

// Change password
app.put('/api/auth/password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const user = dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const valid = await bcrypt.compare(current_password, user.password);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const hash = await bcrypt.hash(new_password, 10);
  dbRun('UPDATE users SET password = ? WHERE id = ?', [hash, req.user.id]);
  res.json({ success: true });
});

// Delete account
app.delete('/api/auth/account', auth, (req, res) => {
  // Delete avatar file
  const user = dbGet('SELECT avatar_url FROM users WHERE id = ?', [req.user.id]);
  if (user && user.avatar_url) {
    const filePath = path.join(__dirname, user.avatar_url);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  dbRun('DELETE FROM study_sessions WHERE user_id = ?', [req.user.id]);
  dbRun('DELETE FROM topics WHERE user_id = ?', [req.user.id]);
  dbRun('DELETE FROM plans WHERE user_id = ?', [req.user.id]);
  dbRun('DELETE FROM users WHERE id = ?', [req.user.id]);
  res.json({ success: true });
});



// ── Auth ─────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const existing = dbGet('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const result = dbRun('INSERT INTO users (name, email, password) VALUES (?, ?, ?)', [name, email, hash]);
    const userId = result.lastInsertRowid;
    seedDefaultPlans(userId);
    const token = jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: userId, name, email, avatar_color: '#00ff88' } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = dbGet('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
  const token = jwt.sign({ id: user.id, email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, avatar_color: user.avatar_color } });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = dbGet('SELECT id, name, email, avatar_color, avatar_url FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// ── Plans ─────────────────────────────────────────────────────────────
app.get('/api/plans', auth, (req, res) => {
  const plans = dbAll('SELECT * FROM plans WHERE user_id = ? ORDER BY created_at', [req.user.id]);
  const result = plans.map(p => ({ ...p, ...getPlanStats(p.id) }));
  res.json(result);
});

app.post('/api/plans', auth, (req, res) => {
  const { plan_name, description, total_days } = req.body;
  if (!plan_name) return res.status(400).json({ error: 'Plan name required' });
  const r = dbRun('INSERT INTO plans (user_id, plan_name, description, total_days) VALUES (?, ?, ?, ?)',
    [req.user.id, plan_name, description || '', total_days || 30]);
  res.json({ id: r.lastInsertRowid, plan_name, description, total_days });
});

app.delete('/api/plans/:id', auth, (req, res) => {
  dbRun('DELETE FROM plans WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ success: true });
});

// Dashboard stats
app.get('/api/plans/stats/dashboard', auth, (req, res) => {
  const plans = dbAll('SELECT id FROM plans WHERE user_id = ?', [req.user.id]);
  let totalCompleted = 0, totalTopics = 0;

  for (const p of plans) {
    const s = getPlanStats(p.id);
    totalCompleted += s.completed_topics;
    totalTopics += s.total_topics;
  }

  const overallProgress = totalTopics > 0 ? Math.round((totalCompleted / totalTopics) * 100) : 0;

  // Calculate streak
  const sessions = dbAll('SELECT session_date FROM study_sessions WHERE user_id = ? ORDER BY session_date DESC', [req.user.id]);
  let streak = 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = 0; i < sessions.length; i++) {
    const d = new Date(sessions[i].session_date); d.setHours(0, 0, 0, 0);
    const diff = Math.round((today - d) / (1000 * 60 * 60 * 24));
    if (diff === i || diff === i + 1) streak++;
    else break;
  }

  res.json({ totalCompleted, totalTopics, overallProgress, streak });
});

// ── Topics ─────────────────────────────────────────────────────────────
app.get('/api/topics/plan/:planId', auth, (req, res) => {
  const topics = dbAll('SELECT * FROM topics WHERE plan_id = ? AND user_id = ? ORDER BY day_number',
    [req.params.planId, req.user.id]);
  res.json(topics.map(t => ({
    ...t,
    subtopics: JSON.parse(t.subtopics || '[]'),
    video_links: JSON.parse(t.video_links || '[]'),
    pdf_links: JSON.parse(t.pdf_links || '[]'),
    tryhackme_done: Boolean(t.tryhackme_done),
    hackviser_done: Boolean(t.hackviser_done)
  })));
});

app.get('/api/topics/:id', auth, (req, res) => {
  const t = dbGet('SELECT * FROM topics WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!t) return res.status(404).json({ error: 'Topic not found' });
  res.json({
    ...t,
    subtopics: JSON.parse(t.subtopics || '[]'),
    video_links: JSON.parse(t.video_links || '[]'),
    pdf_links: JSON.parse(t.pdf_links || '[]'),
    tryhackme_done: Boolean(t.tryhackme_done),
    hackviser_done: Boolean(t.hackviser_done)
  });
});

app.post('/api/topics', auth, (req, res) => {
  const { plan_id, day_number, topic_title, subtopics } = req.body;
  if (!plan_id || !topic_title) return res.status(400).json({ error: 'plan_id and topic_title required' });
  const subs = (subtopics || []).map(s => typeof s === 'string' ? { text: s, done: false } : s);
  const r = dbRun('INSERT INTO topics (plan_id, user_id, day_number, topic_title, subtopics) VALUES (?, ?, ?, ?, ?)',
    [plan_id, req.user.id, day_number || 1, topic_title, JSON.stringify(subs)]);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/topics/:id', auth, (req, res) => {
  const topic = dbGet('SELECT * FROM topics WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!topic) return res.status(404).json({ error: 'Topic not found' });

  const allowed = ['topic_title','subtopics','video_links','pdf_links','notes','tryhackme_link','hackviser_link','tryhackme_done','hackviser_done','day_number'];
  
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const val = Array.isArray(req.body[key]) ? JSON.stringify(req.body[key]) : req.body[key];
      dbRun(`UPDATE topics SET ${key} = ? WHERE id = ?`, [val, req.params.id]);
    }
  }

  const result = recalcProgress(req.params.id);
  res.json({
    ...result,
    subtopics: JSON.parse(result.subtopics || '[]'),
    video_links: JSON.parse(result.video_links || '[]'),
    pdf_links: JSON.parse(result.pdf_links || '[]'),
    tryhackme_done: Boolean(result.tryhackme_done),
    hackviser_done: Boolean(result.hackviser_done),
    isCompleted: result.isNewlyCompleted,
    completedAt: result.completedAt
  });
});

app.delete('/api/topics/:id', auth, (req, res) => {
  dbRun('DELETE FROM topics WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ success: true });
});

// PDF Upload
app.post('/api/topics/:id/upload', auth, upload.single('pdf'), (req, res) => {
  const topic = dbGet('SELECT * FROM topics WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!topic) return res.status(404).json({ error: 'Topic not found' });

  const pdfLinks = JSON.parse(topic.pdf_links || '[]');
  pdfLinks.push({ name: req.file.originalname, url: `/uploads/${req.file.filename}` });
  dbRun('UPDATE topics SET pdf_links = ? WHERE id = ?', [JSON.stringify(pdfLinks), topic.id]);
  res.json({ success: true });
});

// Heatmap
app.get('/api/topics/stats/heatmap/:userId', auth, (req, res) => {
  const data = dbAll('SELECT session_date, count FROM study_sessions WHERE user_id = ? ORDER BY session_date', [req.user.id]);
  res.json(data);
});

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`
  ╔═══════════════════════════════════════╗
  ║      CyberPrep Pro - Server Ready     ║
  ║      http://localhost:${PORT}            ║
  ╚═══════════════════════════════════════╝
    `);
  });
});
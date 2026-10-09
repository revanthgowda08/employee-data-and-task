const express = require('express');
const path = require('node:path');
const { hashPassword, verifyPassword, issueToken, readToken, TTL_MS } = require('./auth');

const WORK_START = process.env.WORK_START || '09:30'; // check-ins after this are "late"
const pad = (n) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStr = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function createApp(db, { basePath = '' } = {}) {
  const app = express();
  app.set('trust proxy', 1); // behind the host's HTTPS proxy
  const cookiePath = basePath || '/';
  const secureFor = (req) => (req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : '');
  app.get('/healthz', (req, res) => res.send('ok'));
  app.use(express.json({ limit: '100kb' }));

  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const publicUser = ({ password_hash, ...u }) => u;

  // ---- auth middleware -------------------------------------------------
  const cookie = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
  app.use('/api', (req, res, next) => {
    const id = readToken(cookie(req, 'session'));
    req.user = id ? one('SELECT * FROM employees WHERE id = ? AND active = 1', id) : null;
    next();
  });
  const needUser = (req) => { if (!req.user) throw new HttpError(401, 'Login required'); return req.user; };
  const needAdmin = (req) => { if (needUser(req).role !== 'admin') throw new HttpError(403, 'Admin only'); return req.user; };
  // wrap handlers so thrown HttpErrors become responses
  const h = (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } };

  // ---- auth routes -----------------------------------------------------
  const fails = new Map(); // ip -> { n, reset }; max 10 failures / 15 min
  app.post('/api/login', h((req, res) => {
    const { email, password } = req.body || {};
    const f = fails.get(req.ip);
    if (f && f.reset > Date.now() && f.n >= 10) throw new HttpError(429, 'Too many failed attempts. Try again later.');
    const u = typeof email === 'string' && typeof password === 'string'
      ? one('SELECT * FROM employees WHERE email = ? AND active = 1', email.trim().toLowerCase()) : null;
    if (!u || !verifyPassword(password, u.password_hash)) {
      const cur = f && f.reset > Date.now() ? f : { n: 0, reset: Date.now() + 15 * 60 * 1000 };
      cur.n++; fails.set(req.ip, cur);
      throw new HttpError(401, 'Invalid email or password');
    }
    fails.delete(req.ip);
    res.setHeader('Set-Cookie', `session=${issueToken(u.id)}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=${TTL_MS / 1000}${secureFor(req)}`);
    res.json(publicUser(u));
  }));
  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', `session=; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=0${secureFor(req)}`);
    res.json({ ok: true });
  });
  app.get('/api/me', h((req, res) => res.json(publicUser(needUser(req)))));

  // ---- employees (admin) -----------------------------------------------
  const empFields = 'id,name,email,role,department,position,phone,joined_on,active';
  app.get('/api/employees', h((req, res) => {
    needUser(req);
    // employees may see a minimal directory; admins see everything
    res.json(req.user.role === 'admin'
      ? all(`SELECT ${empFields} FROM employees ORDER BY active DESC, name`)
      : all('SELECT id,name,department,position FROM employees WHERE active = 1 ORDER BY name'));
  }));

  const cleanEmployee = (b, partial) => {
    const out = {};
    const str = (k, max = 120) => {
      if (b[k] === undefined) return;
      if (typeof b[k] !== 'string' || b[k].length > max) throw bad(`Invalid ${k}`);
      out[k] = b[k].trim();
    };
    ['name', 'department', 'position', 'phone'].forEach((k) => str(k));
    str('email');
    if (out.email !== undefined) {
      out.email = out.email.toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) throw bad('Invalid email');
    }
    if (b.role !== undefined) {
      if (!['admin', 'employee'].includes(b.role)) throw bad('Invalid role');
      out.role = b.role;
    }
    if (b.joined_on !== undefined) {
      if (!DATE_RE.test(b.joined_on)) throw bad('joined_on must be YYYY-MM-DD');
      out.joined_on = b.joined_on;
    }
    if (b.active !== undefined) out.active = b.active ? 1 : 0;
    if (b.password !== undefined) {
      if (typeof b.password !== 'string' || b.password.length < 8) throw bad('Password must be at least 8 characters');
      out.password_hash = hashPassword(b.password);
    }
    if (!partial && (!out.name || !out.email || !out.password_hash)) throw bad('name, email and password are required');
    if (partial && out.name === '') throw bad('name cannot be empty');
    return out;
  };

  app.post('/api/employees', h((req, res) => {
    needAdmin(req);
    const e = cleanEmployee(req.body || {}, false);
    if (one('SELECT 1 FROM employees WHERE email = ?', e.email)) throw new HttpError(409, 'Email already in use');
    const keys = Object.keys(e);
    const r = run(`INSERT INTO employees (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => e[k]));
    res.status(201).json(one(`SELECT ${empFields} FROM employees WHERE id = ?`, r.lastInsertRowid));
  }));

  app.patch('/api/employees/:id', h((req, res) => {
    needAdmin(req);
    const id = Number(req.params.id);
    const cur = one('SELECT * FROM employees WHERE id = ?', id);
    if (!cur) throw new HttpError(404, 'Employee not found');
    const e = cleanEmployee(req.body || {}, true);
    if (id === req.user.id && (e.active === 0 || (e.role && e.role !== 'admin'))) throw bad('You cannot deactivate or demote yourself');
    if (e.email && e.email !== cur.email && one('SELECT 1 FROM employees WHERE email = ?', e.email)) throw new HttpError(409, 'Email already in use');
    const keys = Object.keys(e);
    if (keys.length) run(`UPDATE employees SET ${keys.map((k) => `${k} = ?`).join(',')} WHERE id = ?`, ...keys.map((k) => e[k]), id);
    res.json(one(`SELECT ${empFields} FROM employees WHERE id = ?`, id));
  }));

  // ---- tasks -----------------------------------------------------------
  const taskSelect = `SELECT t.*, a.name AS assignee_name, c.name AS created_by_name,
      CASE WHEN t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date < date('now','localtime') THEN 1 ELSE 0 END AS overdue
    FROM tasks t LEFT JOIN employees a ON a.id = t.assignee_id JOIN employees c ON c.id = t.created_by`;
  const getTask = (id) => one(`${taskSelect} WHERE t.id = ?`, id);
  const logEvent = (taskId, actorId, msg) => run('INSERT INTO task_events (task_id, actor_id, message) VALUES (?,?,?)', taskId, actorId, msg);

  const PRIORITIES = ['low', 'medium', 'high'];
  const STATUSES = ['todo', 'in_progress', 'done'];

  app.get('/api/tasks', h((req, res) => {
    needUser(req);
    const where = []; const p = [];
    if (req.user.role !== 'admin') { where.push('t.assignee_id = ?'); p.push(req.user.id); }
    else if (req.query.assignee) { where.push('t.assignee_id = ?'); p.push(Number(req.query.assignee)); }
    if (req.query.status) {
      if (!STATUSES.includes(req.query.status)) throw bad('Invalid status');
      where.push('t.status = ?'); p.push(req.query.status);
    }
    if (req.query.overdue === '1') where.push("t.status != 'done' AND t.due_date < date('now','localtime')");
    res.json(all(`${taskSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.id DESC`, ...p));
  }));

  app.post('/api/tasks', h((req, res) => {
    needAdmin(req);
    const b = req.body || {};
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) throw bad('title is required (max 200 chars)');
    if (b.description !== undefined && (typeof b.description !== 'string' || b.description.length > 5000)) throw bad('Invalid description');
    const priority = b.priority ?? 'medium';
    if (!PRIORITIES.includes(priority)) throw bad('Invalid priority');
    if (b.due_date != null && b.due_date !== '' && !DATE_RE.test(b.due_date)) throw bad('due_date must be YYYY-MM-DD');
    const assignee = b.assignee_id ? Number(b.assignee_id) : null;
    if (assignee && !one('SELECT 1 FROM employees WHERE id = ? AND active = 1', assignee)) throw bad('Assignee not found');
    const r = run('INSERT INTO tasks (title, description, assignee_id, created_by, priority, due_date) VALUES (?,?,?,?,?,?)',
      b.title.trim(), b.description || '', assignee, req.user.id, priority, b.due_date || null);
    const who = assignee ? one('SELECT name FROM employees WHERE id = ?', assignee).name : 'nobody';
    logEvent(r.lastInsertRowid, req.user.id, `Created and assigned to ${who}`);
    res.status(201).json(getTask(r.lastInsertRowid));
  }));

  app.patch('/api/tasks/:id', h((req, res) => {
    needUser(req);
    const id = Number(req.params.id);
    const t = one('SELECT * FROM tasks WHERE id = ?', id);
    if (!t) throw new HttpError(404, 'Task not found');
    const b = req.body || {};
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin) {
      if (t.assignee_id !== req.user.id) throw new HttpError(403, 'Not your task');
      if (Object.keys(b).some((k) => k !== 'status')) throw new HttpError(403, 'Employees can only update task status');
    }
    const set = {}; const notes = [];
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) throw bad('Invalid status');
      if (b.status !== t.status) {
        set.status = b.status;
        set.completed_at = b.status === 'done' ? new Date().toISOString() : null;
        notes.push(`Status: ${t.status} → ${b.status}`);
      }
    }
    if (isAdmin) {
      if (b.title !== undefined) {
        if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) throw bad('Invalid title');
        set.title = b.title.trim();
      }
      if (b.description !== undefined) {
        if (typeof b.description !== 'string' || b.description.length > 5000) throw bad('Invalid description');
        set.description = b.description;
      }
      if (b.priority !== undefined) {
        if (!PRIORITIES.includes(b.priority)) throw bad('Invalid priority');
        if (b.priority !== t.priority) { set.priority = b.priority; notes.push(`Priority: ${t.priority} → ${b.priority}`); }
      }
      if (b.due_date !== undefined) {
        if (b.due_date && !DATE_RE.test(b.due_date)) throw bad('due_date must be YYYY-MM-DD');
        set.due_date = b.due_date || null;
        if (set.due_date !== t.due_date) notes.push(`Due date: ${t.due_date || 'none'} → ${set.due_date || 'none'}`);
      }
      if (b.assignee_id !== undefined) {
        const a = b.assignee_id ? Number(b.assignee_id) : null;
        if (a && !one('SELECT 1 FROM employees WHERE id = ? AND active = 1', a)) throw bad('Assignee not found');
        if (a !== t.assignee_id) {
          set.assignee_id = a;
          notes.push(`Reassigned to ${a ? one('SELECT name FROM employees WHERE id = ?', a).name : 'nobody'}`);
        }
      }
    }
    const keys = Object.keys(set);
    if (keys.length) {
      run(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(',')} WHERE id = ?`, ...keys.map((k) => set[k]), id);
      notes.forEach((n) => logEvent(id, req.user.id, n));
    }
    res.json(getTask(id));
  }));

  app.delete('/api/tasks/:id', h((req, res) => {
    needAdmin(req);
    const r = run('DELETE FROM tasks WHERE id = ?', Number(req.params.id));
    if (!r.changes) throw new HttpError(404, 'Task not found');
    res.json({ ok: true });
  }));

  app.get('/api/tasks/:id/events', h((req, res) => {
    needUser(req);
    const t = one('SELECT assignee_id FROM tasks WHERE id = ?', Number(req.params.id));
    if (!t) throw new HttpError(404, 'Task not found');
    if (req.user.role !== 'admin' && t.assignee_id !== req.user.id) throw new HttpError(403, 'Not your task');
    res.json(all(`SELECT e.id, e.message, e.at, p.name AS actor FROM task_events e JOIN employees p ON p.id = e.actor_id
      WHERE e.task_id = ? ORDER BY e.id DESC`, Number(req.params.id)));
  }));

  // ---- attendance ------------------------------------------------------
  app.post('/api/attendance/check-in', h((req, res) => {
    needUser(req);
    const now = new Date(); const date = todayStr(now); const time = timeStr(now);
    const cur = one('SELECT * FROM attendance WHERE employee_id = ? AND date = ?', req.user.id, date);
    if (cur?.check_in) throw new HttpError(409, 'Already checked in today');
    const status = time > WORK_START ? 'late' : 'present';
    if (cur) run('UPDATE attendance SET check_in = ?, status = ? WHERE id = ?', time, status, cur.id); // admin pre-marked row
    else run('INSERT INTO attendance (employee_id, date, check_in, status) VALUES (?,?,?,?)', req.user.id, date, time, status);
    res.status(201).json(one('SELECT * FROM attendance WHERE employee_id = ? AND date = ?', req.user.id, date));
  }));

  app.post('/api/attendance/check-out', h((req, res) => {
    needUser(req);
    const date = todayStr();
    const cur = one('SELECT * FROM attendance WHERE employee_id = ? AND date = ?', req.user.id, date);
    if (!cur?.check_in) throw new HttpError(409, 'You have not checked in today');
    if (cur.check_out) throw new HttpError(409, 'Already checked out today');
    run('UPDATE attendance SET check_out = ? WHERE id = ?', timeStr(), cur.id);
    res.json(one('SELECT * FROM attendance WHERE id = ?', cur.id));
  }));

  app.get('/api/attendance', h((req, res) => {
    needUser(req);
    const month = req.query.month || todayStr().slice(0, 7);
    const from = req.query.from || `${month}-01`;
    const to = req.query.to || `${month}-31`;
    if (![from, to].every((d) => DATE_RE.test(d))) throw bad('from/to must be YYYY-MM-DD');
    const where = ['a.date BETWEEN ? AND ?']; const p = [from, to];
    if (req.user.role !== 'admin') { where.push('a.employee_id = ?'); p.push(req.user.id); }
    else if (req.query.employee_id) { where.push('a.employee_id = ?'); p.push(Number(req.query.employee_id)); }
    res.json(all(`SELECT a.*, e.name AS employee_name FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE ${where.join(' AND ')} ORDER BY a.date DESC, e.name`, ...p));
  }));

  // Admin: mark/correct a day (e.g. leave, absent, fix times)
  app.put('/api/attendance', h((req, res) => {
    needAdmin(req);
    const { employee_id, date, status, check_in = null, check_out = null, note = '' } = req.body || {};
    if (!one('SELECT 1 FROM employees WHERE id = ?', Number(employee_id))) throw bad('Unknown employee');
    if (!DATE_RE.test(date || '')) throw bad('date must be YYYY-MM-DD');
    if (!['present', 'late', 'absent', 'leave'].includes(status)) throw bad('Invalid status');
    for (const t of [check_in, check_out]) if (t != null && !/^\d{2}:\d{2}$/.test(t)) throw bad('Times must be HH:MM');
    run(`INSERT INTO attendance (employee_id, date, check_in, check_out, status, note) VALUES (?,?,?,?,?,?)
      ON CONFLICT (employee_id, date) DO UPDATE SET check_in = excluded.check_in, check_out = excluded.check_out,
      status = excluded.status, note = excluded.note`, Number(employee_id), date, check_in, check_out, status, String(note).slice(0, 500));
    res.json(one('SELECT * FROM attendance WHERE employee_id = ? AND date = ?', Number(employee_id), date));
  }));

  // Admin: per-employee monthly summary
  app.get('/api/attendance/summary', h((req, res) => {
    needAdmin(req);
    const month = req.query.month || todayStr().slice(0, 7);
    if (!MONTH_RE.test(month)) throw bad('month must be YYYY-MM');
    res.json(all(`SELECT e.id AS employee_id, e.name, e.department,
        COALESCE(SUM(a.status = 'present'), 0) AS present, COALESCE(SUM(a.status = 'late'), 0) AS late,
        COALESCE(SUM(a.status = 'absent'), 0) AS absent, COALESCE(SUM(a.status = 'leave'), 0) AS leave
      FROM employees e LEFT JOIN attendance a ON a.employee_id = e.id AND substr(a.date,1,7) = ?
      WHERE e.active = 1 GROUP BY e.id ORDER BY e.name`, month));
  }));

  // ---- dashboard -------------------------------------------------------
  app.get('/api/dashboard', h((req, res) => {
    needUser(req);
    const today = todayStr();
    const counts = (where, ...p) => {
      const r = one(`SELECT COUNT(*) total, COALESCE(SUM(status='todo'),0) todo, COALESCE(SUM(status='in_progress'),0) in_progress,
        COALESCE(SUM(status='done'),0) done, COALESCE(SUM(status!='done' AND due_date < ?),0) overdue FROM tasks WHERE ${where}`, today, ...p);
      return r;
    };
    if (req.user.role !== 'admin') {
      const month = today.slice(0, 7);
      return res.json({
        role: 'employee',
        tasks: counts('assignee_id = ?', req.user.id),
        today: one('SELECT * FROM attendance WHERE employee_id = ? AND date = ?', req.user.id, today) || null,
        month: one(`SELECT COALESCE(SUM(status='present'),0) present, COALESCE(SUM(status='late'),0) late,
          COALESCE(SUM(status='absent'),0) absent, COALESCE(SUM(status='leave'),0) leave
          FROM attendance WHERE employee_id = ? AND substr(date,1,7) = ?`, req.user.id, month),
      });
    }
    const active = one('SELECT COUNT(*) n FROM employees WHERE active = 1').n;
    const att = one(`SELECT COALESCE(SUM(status='present'),0) present, COALESCE(SUM(status='late'),0) late,
      COALESCE(SUM(status='leave'),0) leave, COALESCE(SUM(status='absent'),0) absent_marked
      FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE a.date = ? AND e.active = 1`, today);
    const notIn = all(`SELECT e.id, e.name, e.department FROM employees e WHERE e.active = 1 AND NOT EXISTS
      (SELECT 1 FROM attendance a WHERE a.employee_id = e.id AND a.date = ? AND (a.check_in IS NOT NULL OR a.status IN ('leave','absent')))
      ORDER BY e.name`, today);
    res.json({
      role: 'admin',
      employees: { active },
      attendanceToday: { ...att, notCheckedIn: notIn.length, notCheckedInList: notIn },
      tasks: counts('1=1'),
      workload: all(`SELECT e.id, e.name, e.department,
          COALESCE(SUM(t.status='todo'),0) todo, COALESCE(SUM(t.status='in_progress'),0) in_progress,
          COALESCE(SUM(t.status='done'),0) done, COALESCE(SUM(t.status!='done' AND t.due_date < ?),0) overdue
        FROM employees e LEFT JOIN tasks t ON t.assignee_id = e.id WHERE e.active = 1 GROUP BY e.id ORDER BY e.name`, today),
      recent: all(`SELECT ev.at, ev.message, p.name AS actor, t.title, t.id AS task_id FROM task_events ev
        JOIN employees p ON p.id = ev.actor_id JOIN tasks t ON t.id = ev.task_id ORDER BY ev.id DESC LIMIT 10`),
    });
  }));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

module.exports = { createApp };

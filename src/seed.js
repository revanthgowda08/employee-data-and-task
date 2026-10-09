const { hashPassword } = require('./auth');

// Creates the first admin so you can log in. Set ADMIN_EMAIL / ADMIN_PASSWORD to override the defaults.
function seedAdminIfEmpty(db) {
  if (db.prepare('SELECT COUNT(*) n FROM employees').get().n > 0) return false;
  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD before the first production start');
  }
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'admin12345';
  db.prepare("INSERT INTO employees (name, email, password_hash, role, department, position) VALUES ('Admin', ?, ?, 'admin', 'Management', 'Administrator')")
    .run(email, hashPassword(password));
  console.log(`Created initial admin: ${email} / ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : password} — change it after first login`);
  return true;
}

// `npm run seed` loads demo employees, tasks and attendance
function seedDemo(db) {
  seedAdminIfEmpty(db);
  const ins = db.prepare('INSERT OR IGNORE INTO employees (name,email,password_hash,department,position) VALUES (?,?,?,?,?)');
  const people = [['Asha Rao', 'asha@example.com', 'Engineering', 'Developer'], ['Ravi Kumar', 'ravi@example.com', 'Engineering', 'QA Engineer'],
    ['Meera Shah', 'meera@example.com', 'Design', 'Designer'], ['John Dsouza', 'john@example.com', 'Sales', 'Executive']];
  const hash = hashPassword('employee123');
  people.forEach(([n, e, d, p]) => ins.run(n, e, hash, d, p));
  const admin = db.prepare("SELECT id FROM employees WHERE role='admin' LIMIT 1").get().id;
  const emps = db.prepare("SELECT id FROM employees WHERE role='employee'").all().map((r) => r.id);
  const d = (off) => { const x = new Date(Date.now() + off * 864e5); return x.toISOString().slice(0, 10); };
  const t = db.prepare('INSERT INTO tasks (title,assignee_id,created_by,priority,status,due_date) VALUES (?,?,?,?,?,?)');
  [['Build login page', 0, 'high', 'in_progress', 2], ['Write test plan', 1, 'medium', 'todo', -1], ['Landing page mockups', 2, 'medium', 'done', -3],
    ['Follow up with 5 leads', 3, 'low', 'todo', 5], ['Fix payment bug', 0, 'high', 'todo', 1]]
    .forEach(([title, i, pr, st, off]) => t.run(title, emps[i], admin, pr, st, d(off)));
  const a = db.prepare('INSERT OR IGNORE INTO attendance (employee_id,date,check_in,check_out,status) VALUES (?,?,?,?,?)');
  for (let off = -10; off < 0; off++) {
    if ([0, 6].includes(new Date(Date.now() + off * 864e5).getDay())) continue;
    emps.forEach((id, i) => a.run(id, d(off), (i + off) % 4 === 0 ? '09:50' : '09:10', '18:00', (i + off) % 4 === 0 ? 'late' : 'present'));
  }
  console.log('Demo data loaded. Employees log in with password: employee123');
}

module.exports = { seedAdminIfEmpty, seedDemo };

if (require.main === module) seedDemo(require('./db').openDb());

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { seedAdminIfEmpty } = require('../src/seed');

let server, base;
before(async () => {
  const db = openDb(':memory:');
  seedAdminIfEmpty(db);
  server = createApp(db).listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function call(method, url, body, cookie) {
  const res = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const login = async (email, password) => (await call('POST', '/api/login', { email, password })).cookie;

test('end-to-end: admin creates employee, assigns task, employee works it and tracks attendance', async () => {
  assert.equal((await call('GET', '/api/tasks')).status, 401);
  assert.equal((await call('POST', '/api/login', { email: 'admin@example.com', password: 'nope' })).status, 401);
  const admin = await login('admin@example.com', 'admin12345');

  const emp = await call('POST', '/api/employees', { name: 'Asha', email: 'Asha@Example.com', password: 'password1', department: 'Eng' }, admin);
  assert.equal(emp.status, 201);
  assert.equal(emp.body.email, 'asha@example.com');
  assert.equal(emp.body.password_hash, undefined);
  assert.equal((await call('POST', '/api/employees', { name: 'Dup', email: 'asha@example.com', password: 'password1' }, admin)).status, 409);
  assert.equal((await call('POST', '/api/employees', { name: 'X', email: 'x@e.com', password: 'short' }, admin)).status, 400);

  const asha = await login('asha@example.com', 'password1');
  assert.equal((await call('POST', '/api/employees', { name: 'B', email: 'b@e.com', password: 'password1' }, asha)).status, 403);

  const task = await call('POST', '/api/tasks', { title: 'Ship it', assignee_id: emp.body.id, priority: 'high', due_date: '2000-01-01' }, admin);
  assert.equal(task.status, 201);
  assert.equal(task.body.overdue, 1);
  assert.equal((await call('POST', '/api/tasks', { title: 'x' }, asha)).status, 403);

  const mine = await call('GET', '/api/tasks', null, asha);
  assert.equal(mine.body.length, 1);
  // employee may change status only
  assert.equal((await call('PATCH', `/api/tasks/${task.body.id}`, { title: 'hax' }, asha)).status, 403);
  const done = await call('PATCH', `/api/tasks/${task.body.id}`, { status: 'done' }, asha);
  assert.equal(done.body.status, 'done');
  assert.equal(done.body.overdue, 0);
  assert.ok(done.body.completed_at);
  const events = await call('GET', `/api/tasks/${task.body.id}/events`, null, admin);
  assert.ok(events.body.length >= 2);

  // another employee can't touch it
  const other = await call('POST', '/api/employees', { name: 'Ravi', email: 'ravi@example.com', password: 'password1' }, admin);
  const ravi = await login('ravi@example.com', 'password1');
  assert.equal((await call('PATCH', `/api/tasks/${task.body.id}`, { status: 'todo' }, ravi)).status, 403);
  assert.equal((await call('GET', '/api/tasks', null, ravi)).body.length, 0);

  // attendance
  assert.equal((await call('POST', '/api/attendance/check-out', null, asha)).status, 409);
  assert.equal((await call('POST', '/api/attendance/check-in', null, asha)).status, 201);
  assert.equal((await call('POST', '/api/attendance/check-in', null, asha)).status, 409);
  assert.equal((await call('POST', '/api/attendance/check-out', null, asha)).status, 200);
  assert.equal((await call('GET', '/api/attendance', null, asha)).body.length, 1);

  // admin marks Ravi on leave, then dashboard reflects it
  const today = new Date(); const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.equal((await call('PUT', '/api/attendance', { employee_id: other.body.id, date: d, status: 'leave' }, admin)).status, 200);
  const dash = await call('GET', '/api/dashboard', null, admin);
  assert.equal(dash.body.employees.active, 3);
  assert.equal(dash.body.attendanceToday.leave, 1);
  assert.equal(dash.body.attendanceToday.notCheckedIn, 1); // the admin
  assert.equal(dash.body.tasks.done, 1);
  const summary = await call('GET', '/api/attendance/summary', null, admin);
  assert.equal(summary.body.find((r) => r.name === 'Ravi').leave, 1);
  const empDash = await call('GET', '/api/dashboard', null, asha);
  assert.equal(empDash.body.role, 'employee');
  assert.equal(empDash.body.tasks.done, 1);

  // deactivated employee loses access; admin can't deactivate self
  assert.equal((await call('PATCH', `/api/employees/${other.body.id}`, { active: false }, admin)).status, 200);
  assert.equal((await call('GET', '/api/me', null, ravi)).status, 401);
  assert.equal((await call('PATCH', '/api/employees/1', { active: false }, admin)).status, 400);
});

test('tampered session cookie is rejected', async () => {
  const admin = await login('admin@example.com', 'admin12345');
  assert.equal((await call('GET', '/api/me', null, admin.slice(0, -2) + 'xx')).status, 401);
});

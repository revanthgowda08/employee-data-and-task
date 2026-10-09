'use strict';
const $app = document.getElementById('app');
let me = null, view = 'dashboard', employees = [];

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = (s) => ({ todo: 'To do', in_progress: 'In progress', done: 'Done' }[s] || s[0].toUpperCase() + s.slice(1));
const badge = (s, text) => `<span class="badge ${esc(s)}">${esc(text ?? label(s))}</span>`;
const isAdmin = () => me?.role === 'admin';
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function api(method, url, body) {
  const res = await fetch('api' + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/login') { me = null; render(); throw new Error('Please log in'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
function modal(html, onSubmit) {
  const el = document.createElement('div'); el.className = 'modal';
  el.innerHTML = `<form class="card">${html}<p class="err"></p><div class="row"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-x>Cancel</button></div></form>`;
  document.body.append(el);
  const close = () => el.remove();
  el.querySelector('[data-x]').onclick = close;
  el.onclick = (e) => { if (e.target === el) close(); };
  el.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    try { await onSubmit(Object.fromEntries(new FormData(e.target)), close); } catch (err) { el.querySelector('.err').textContent = err.message; }
  };
  el.querySelector('input,select,textarea')?.focus();
}
const empOptions = (sel, blank) => (blank ? `<option value="">— Unassigned —</option>` : '') +
  employees.filter((e) => e.active !== 0).map((e) => `<option value="${e.id}" ${String(sel) === String(e.id) ? 'selected' : ''}>${esc(e.name)}</option>`).join('');

// ---------- shell ----------
function render() {
  if (!me) return renderLogin();
  const tabs = [['dashboard', 'Dashboard'], ['tasks', 'Tasks'], ['attendance', 'Attendance'], ...(isAdmin() ? [['employees', 'Employees']] : [])];
  $app.innerHTML = `<header><h1>Team Dashboard</h1>
    <nav>${tabs.map(([k, n]) => `<button data-v="${k}" class="${view === k ? 'on' : ''}">${n}</button>`).join('')}</nav>
    <span class="who">${esc(me.name)} · ${esc(me.role)}</span><button class="btn ghost sm" id="logout">Log out</button></header><main id="main"></main>`;
  $app.querySelectorAll('nav button').forEach((b) => b.onclick = () => { view = b.dataset.v; render(); });
  document.getElementById('logout').onclick = guard(async () => { await api('POST', '/logout'); me = null; render(); });
  guard(views[view])();
}
const main = () => document.getElementById('main');

function renderLogin() {
  $app.innerHTML = `<form class="login card"><h2>Sign in</h2>
    <label>Email<input name="email" type="email" required autocomplete="username"></label>
    <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
    <p class="err" id="lerr"></p><button class="btn" style="width:100%">Sign in</button></form>`;
  $app.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      me = await api('POST', '/login', Object.fromEntries(new FormData(e.target)));
      employees = await api("GET", "/employees");
      view = 'dashboard'; render();
    } catch (err) { document.getElementById('lerr').textContent = err.message; }
  };
}

const stat = (n, l, cls = '') => `<div class="card stat"><b class="${cls}">${n}</b><span>${l}</span></div>`;

// ---------- views ----------
const views = {
  async dashboard() {
    const d = await api('GET', '/dashboard');
    if (d.role === 'employee') {
      const a = d.today;
      main().innerHTML = `<h2>Hello, ${esc(me.name.split(' ')[0])}</h2>
        <div class="card"><h3>Today's attendance</h3>
          <p>${a?.check_in ? `Checked in at <b>${a.check_in}</b> ${badge(a.status)}${a.check_out ? ` · out at <b>${a.check_out}</b>` : ''}` : '<span class="muted">Not checked in yet</span>'}</p>
          <button class="btn" id="cin" ${a?.check_in ? 'disabled' : ''}>Check in</button>
          <button class="btn ghost" id="cout" ${!a?.check_in || a.check_out ? 'disabled' : ''}>Check out</button></div>
        <div class="grid">${stat(d.tasks.todo, 'To do')}${stat(d.tasks.in_progress, 'In progress')}${stat(d.tasks.done, 'Done')}${stat(d.tasks.overdue, 'Overdue', d.tasks.overdue ? 'overdue' : '')}</div>
        <div class="card"><h3>This month</h3>${badge('present', `${d.month.present} present`)} ${badge('late', `${d.month.late} late`)} ${badge('leave', `${d.month.leave} leave`)} ${badge('absent', `${d.month.absent} absent`)}</div>`;
      document.getElementById('cin').onclick = guard(async () => { await api('POST', '/attendance/check-in'); toast('Checked in'); views.dashboard(); });
      document.getElementById('cout').onclick = guard(async () => { await api('POST', '/attendance/check-out'); toast('Checked out'); views.dashboard(); });
      return;
    }
    const at = d.attendanceToday, t = d.tasks;
    main().innerHTML = `<h2>Overview</h2>
      <div class="grid">${stat(d.employees.active, 'Active employees')}${stat(at.present + at.late, 'Checked in today')}${stat(at.late, 'Late today')}${stat(at.leave, 'On leave')}${stat(at.notCheckedIn, 'Not checked in')}</div>
      <div class="grid">${stat(t.todo, 'To do')}${stat(t.in_progress, 'In progress')}${stat(t.done, 'Done')}${stat(t.overdue, 'Overdue tasks')}</div>
      <div class="two"><div class="card"><h3>Workload by employee</h3><div class="scroll"><table><tr><th>Name</th><th>Open</th><th>Done</th><th>Overdue</th><th></th></tr>
        ${d.workload.map((w) => { const tot = w.todo + w.in_progress + w.done || 1; return `<tr><td>${esc(w.name)}<br><small class="muted">${esc(w.department)}</small></td><td>${w.todo + w.in_progress}</td><td>${w.done}</td><td>${w.overdue ? badge('overdue', w.overdue) : 0}</td>
          <td><div class="bar"><i class="t" style="width:${w.todo / tot * 100}%"></i><i class="p" style="width:${w.in_progress / tot * 100}%"></i><i class="d" style="width:${w.done / tot * 100}%"></i></div></td></tr>`; }).join('')}</table></div></div>
      <div><div class="card"><h3>Not checked in today</h3>${at.notCheckedInList.length ? at.notCheckedInList.map((e) => esc(e.name)).join(', ') : '<span class="muted">Everyone is accounted for</span>'}</div>
      <div class="card"><h3>Recent task activity</h3>${d.recent.length ? d.recent.map((r) => `<p><b>${esc(r.actor)}</b> on “${esc(r.title)}”: ${esc(r.message)}<br><small class="muted">${esc(r.at)} UTC</small></p>`).join('') : '<span class="muted">No activity yet</span>'}</div></div></div>`;
  },

  async tasks() {
    const q = views._tq || (views._tq = { status: '', assignee: '' });
    const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
    const tasks = await api('GET', '/tasks' + (params ? '?' + params : ''));
    main().innerHTML = `<div class="row"><h2 style="flex:1;margin:0">${isAdmin() ? 'All tasks' : 'My tasks'}</h2>
      ${isAdmin() ? '<button class="btn" id="newtask">+ New task</button>' : ''}</div>
      <div class="row"><label>Status<select id="fs"><option value="">All</option>${['todo', 'in_progress', 'done'].map((s) => `<option value="${s}" ${q.status === s ? 'selected' : ''}>${label(s)}</option>`).join('')}</select></label>
      ${isAdmin() ? `<label>Assignee<select id="fa"><option value="">Everyone</option>${empOptions(q.assignee)}</select></label>` : ''}</div>
      <div class="card scroll"><table><tr><th>Task</th>${isAdmin() ? '<th>Assignee</th>' : ''}<th>Priority</th><th>Due</th><th>Status</th><th></th></tr>
      ${tasks.map((t) => `<tr><td><b>${esc(t.title)}</b>${t.description ? `<br><small class="muted">${esc(t.description)}</small>` : ''}</td>
        ${isAdmin() ? `<td>${esc(t.assignee_name || '—')}</td>` : ''}<td>${badge(t.priority)}</td>
        <td>${esc(t.due_date || '—')} ${t.overdue ? badge('overdue', 'Overdue') : ''}</td>
        <td><select data-st="${t.id}" style="width:auto">${['todo', 'in_progress', 'done'].map((s) => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${label(s)}</option>`).join('')}</select></td>
        <td style="white-space:nowrap"><button class="btn ghost sm" data-hist="${t.id}">History</button>${isAdmin() ? ` <button class="btn ghost sm" data-edit="${t.id}">Edit</button> <button class="btn danger sm" data-del="${t.id}">Delete</button>` : ''}</td></tr>`).join('') ||
        `<tr><td colspan="6" class="muted">No tasks found.</td></tr>`}</table></div>`;
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    document.getElementById('fs').onchange = (e) => { q.status = e.target.value; views.tasks(); };
    document.getElementById('fa')?.addEventListener('change', (e) => { q.assignee = e.target.value; views.tasks(); });
    main().querySelectorAll('[data-st]').forEach((s) => s.onchange = guard(async () => { await api('PATCH', `/tasks/${s.dataset.st}`, { status: s.value }); toast('Status updated'); views.tasks(); }));
    main().querySelectorAll('[data-hist]').forEach((b) => b.onclick = guard(async () => {
      const ev = await api('GET', `/tasks/${b.dataset.hist}/events`);
      modal(`<h3>History</h3>${ev.map((e) => `<p><b>${esc(e.actor)}</b>: ${esc(e.message)}<br><small class="muted">${esc(e.at)} UTC</small></p>`).join('') || 'No events'}`, (_, close) => close());
    }));
    if (!isAdmin()) return;
    document.getElementById('newtask').onclick = () => taskForm();
    main().querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => taskForm(byId[b.dataset.edit]));
    main().querySelectorAll('[data-del]').forEach((b) => b.onclick = guard(async () => { if (confirm('Delete this task?')) { await api('DELETE', `/tasks/${b.dataset.del}`); views.tasks(); } }));
  },

  async attendance() {
    const month = views._month || today().slice(0, 7);
    const rows = await api('GET', `/attendance?month=${month}`);
    const monthPick = `<label>Month<input type="month" id="mp" value="${month}"></label>`;
    let summary = '';
    if (isAdmin()) {
      const s = await api('GET', `/attendance/summary?month=${month}`);
      summary = `<div class="card scroll"><h3>Monthly summary</h3><table><tr><th>Employee</th><th>Present</th><th>Late</th><th>Leave</th><th>Absent</th></tr>
        ${s.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.present}</td><td>${r.late}</td><td>${r.leave}</td><td>${r.absent}</td></tr>`).join('')}</table></div>`;
    }
    main().innerHTML = `<div class="row"><h2 style="flex:1;margin:0">Attendance</h2>${isAdmin() ? '<button class="btn" id="mark">Mark / correct a day</button>' : ''}</div>
      <div class="row">${monthPick}</div>${summary}
      <div class="card scroll"><h3>Daily records</h3><table><tr><th>Date</th>${isAdmin() ? '<th>Employee</th>' : ''}<th>In</th><th>Out</th><th>Status</th><th>Note</th></tr>
      ${rows.map((r) => `<tr><td>${r.date}</td>${isAdmin() ? `<td>${esc(r.employee_name)}</td>` : ''}<td>${r.check_in || '—'}</td><td>${r.check_out || '—'}</td><td>${badge(r.status)}</td><td>${esc(r.note)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No records this month.</td></tr>'}</table></div>`;
    document.getElementById('mp').onchange = (e) => { if (e.target.value) { views._month = e.target.value; views.attendance(); } };
    document.getElementById('mark')?.addEventListener('click', () => modal(`<h3>Mark attendance</h3>
      <label>Employee<select name="employee_id">${empOptions('')}</select></label>
      <label>Date<input type="date" name="date" value="${today()}" required></label>
      <label>Status<select name="status">${['present', 'late', 'leave', 'absent'].map((s) => `<option value="${s}">${label(s)}</option>`).join('')}</select></label>
      <div class="row"><label>Check in<input type="time" name="check_in"></label><label>Check out<input type="time" name="check_out"></label></div>
      <label>Note<input name="note" maxlength="500"></label>`, async (f, close) => {
      await api('PUT', '/attendance', { ...f, check_in: f.check_in || null, check_out: f.check_out || null }); close(); toast('Saved'); views.attendance();
    }));
  },

  async employees() {
    employees = await api('GET', '/employees');
    main().innerHTML = `<div class="row"><h2 style="flex:1;margin:0">Employees</h2><button class="btn" id="newemp">+ Add employee</button></div>
      <div class="card scroll"><table><tr><th>Name</th><th>Email</th><th>Department</th><th>Position</th><th>Role</th><th>Joined</th><th></th></tr>
      ${employees.map((e) => `<tr style="${e.active ? '' : 'opacity:.5'}"><td>${esc(e.name)}</td><td>${esc(e.email)}</td><td>${esc(e.department)}</td><td>${esc(e.position)}</td>
        <td>${badge(e.role === 'admin' ? 'ok' : 'todo', e.role)}</td><td>${e.joined_on}</td><td><button class="btn ghost sm" data-e="${e.id}">Edit</button></td></tr>`).join('')}</table></div>`;
    document.getElementById('newemp').onclick = () => empForm();
    main().querySelectorAll('[data-e]').forEach((b) => b.onclick = () => empForm(employees.find((e) => e.id == b.dataset.e)));
  },
};

// ---------- forms ----------
function taskForm(t) {
  modal(`<h3>${t ? 'Edit' : 'New'} task</h3>
    <label>Title<input name="title" required maxlength="200" value="${esc(t?.title)}"></label>
    <label>Description<textarea name="description" rows="3">${esc(t?.description)}</textarea></label>
    <label>Assign to<select name="assignee_id">${empOptions(t?.assignee_id, true)}</select></label>
    <div class="row"><label>Priority<select name="priority">${['low', 'medium', 'high'].map((p) => `<option ${((t?.priority || 'medium') === p) ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    <label>Due date<input type="date" name="due_date" value="${esc(t?.due_date || '')}"></label></div>`, async (f, close) => {
    if (t) await api('PATCH', `/tasks/${t.id}`, f); else await api('POST', '/tasks', f);
    close(); toast('Task saved'); views.tasks();
  });
}

function empForm(e) {
  modal(`<h3>${e ? 'Edit' : 'Add'} employee</h3>
    <label>Name<input name="name" required value="${esc(e?.name)}"></label>
    <label>Email<input name="email" type="email" required value="${esc(e?.email)}"></label>
    <label>${e ? 'New password (leave blank to keep)' : 'Password (min 8 chars)'}<input name="password" type="password" minlength="8" ${e ? '' : 'required'} autocomplete="new-password"></label>
    <div class="row"><label>Department<input name="department" value="${esc(e?.department)}"></label><label>Position<input name="position" value="${esc(e?.position)}"></label></div>
    <div class="row"><label>Phone<input name="phone" value="${esc(e?.phone)}"></label>
    <label>Role<select name="role"><option value="employee" ${e?.role === 'employee' ? 'selected' : ''}>Employee</option><option value="admin" ${e?.role === 'admin' ? 'selected' : ''}>Admin</option></select></label></div>
    ${e ? `<label>Status<select name="active"><option value="1" ${e.active ? 'selected' : ''}>Active</option><option value="0" ${e.active ? '' : 'selected'}>Deactivated (cannot log in)</option></select></label>` : ''}`, async (f, close) => {
    if (!f.password) delete f.password;
    if (f.active !== undefined) f.active = f.active === '1';
    if (e) await api('PATCH', `/employees/${e.id}`, f); else await api('POST', '/employees', f);
    close(); toast('Employee saved'); views.employees();
  });
}

// ---------- boot ----------
(async () => {
  try { me = await api('GET', '/me'); employees = await api('GET', '/employees'); } catch { me = null; }
  render();
})();

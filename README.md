# Employee Data, Tasks & Attendance Dashboard

Admins manage employees, assign tasks and track attendance. Employees log in to see their own tasks,
update status, and check in/out.

## Run

```bash
npm install
npm start            # http://localhost:3000
npm run seed         # optional: demo employees, tasks, attendance (password: employee123)
npm test
```

Needs Node 22.13+ (uses built-in `node:sqlite`). First start creates an admin:
`admin@example.com` / `admin12345` — change it via **Employees → Edit**, or set `ADMIN_EMAIL` / `ADMIN_PASSWORD`
before the first start.

Env vars: `PORT`, `DB_FILE` (default `data/app.db`), `SESSION_SECRET` (set this in production, otherwise
sessions reset on restart), `WORK_START` (default `09:30`; later check-ins are marked *late*).

## Features

| | Admin | Employee |
|---|---|---|
| Dashboard | headcount, today's attendance, task totals, overdue, per-person workload, activity feed | own task counts, check-in/out, month summary |
| Employees | add / edit / deactivate / reset password | — |
| Tasks | create, assign, reassign, edit, delete, filter | see own, update status |
| Attendance | mark leave/absent, correct times, monthly summary | check in / out, own history |

Task changes are logged (task → History). Deactivated employees can't log in.

## API (JSON, cookie session)

`POST /api/login|logout`, `GET /api/me`, `GET|POST /api/employees`, `PATCH /api/employees/:id`,
`GET|POST /api/tasks`, `PATCH|DELETE /api/tasks/:id`, `GET /api/tasks/:id/events`,
`POST /api/attendance/check-in|check-out`, `GET|PUT /api/attendance`, `GET /api/attendance/summary`, `GET /api/dashboard`.

## Notes / next steps

Basic MVP: no password-reset email, login rate-limiting or HTTPS (put it behind a TLS proxy and add
the `Secure` cookie flag). Good next additions: leave requests, CSV export, task comments, notifications.

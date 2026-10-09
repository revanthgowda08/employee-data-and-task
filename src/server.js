const { openDb } = require('./db');
const { createApp } = require('./app');
const { seedAdminIfEmpty } = require('./seed');

const db = openDb();
seedAdminIfEmpty(db);
const port = process.env.PORT || 3000;
createApp(db).listen(port, () => console.log(`Dashboard running at http://localhost:${port}`));

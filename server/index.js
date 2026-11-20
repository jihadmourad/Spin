'use strict';

const { openDatabase } = require('./db');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const db = openDatabase();
const app = createApp(db);

app.listen(port, () => {
  console.log(`Rassif Spin & Win listening on http://localhost:${port}`);
  console.log(`Admin dashboard: http://localhost:${port}/admin`);
});

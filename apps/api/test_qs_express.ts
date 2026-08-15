import express from 'express';
import fetch from 'node-fetch';
const app = express();
app.get('/test', (req, res) => {
  const where: any = {};
  if (req.query.status) {
    where.status = Array.isArray(req.query.status) ? { in: req.query.status } : req.query.status;
  }
  res.json({ where, queryStatus: req.query.status, isArray: Array.isArray(req.query.status) });
});
app.listen(4005, async () => {
  const res = await fetch('http://localhost:4005/test?status=PENDING&status=PARTIALLY_FILLED');
  console.log(await res.json());
  process.exit(0);
});

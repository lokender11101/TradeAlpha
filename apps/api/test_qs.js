const q = { status: ['PENDING', 'PARTIALLY_FILLED'] };
const where = {};
where.status = Array.isArray(q.status) ? { in: q.status } : q.status;
console.log(where);

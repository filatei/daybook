/**
 * Daybook — sales-source connectivity test.
 * Run inside the container:  docker exec daybook node backend/salestest.js [YYYY-MM-DD]
 * (wrapped as the `daybook-sales-test` command on the server.)
 *
 * Pings the tunnelled fido Mongo and prints a sample by-site aggregate, so you
 * can confirm the whole chain (tunnel → auth → data) without using the UI.
 */
'use strict';
const sales = require('./salesSource');

(async () => {
  const date = process.argv[2] || new Date().toLocaleDateString('en-CA', { timeZone: process.env.SALES_TZ || 'Africa/Lagos' });
  console.log('SALES_MONGO_URL configured:', !!process.env.SALES_MONGO_URL);
  if (!sales.salesEnabled()) { console.error('✗ SALES_MONGO_URL not set in the container env (set it in .env and run daybook-deploy)'); process.exit(2); }
  process.stdout.write('Connecting through the tunnel… ');
  const p = await sales.ping();
  if (!p.ok) { console.error('FAILED\n✗', p.error); process.exit(1); }
  console.log('OK');
  const rows = await sales.query({ from: date, to: date, groupBy: 'site' });
  if (!rows.length) { console.log(`No sales found for ${date} (try another date).`); process.exit(0); }
  console.log(`\nSales by site for ${date}:`);
  let total = 0;
  for (const r of rows) { console.log(`  ${String(r.group).padEnd(12)} ₦${(r.amount).toLocaleString()}  (${r.orders} orders)`); total += r.amount; }
  console.log(`  ${'TOTAL'.padEnd(12)} ₦${total.toLocaleString()}`);
  process.exit(0);
})().catch((e) => { console.error('✗ ERROR:', e.message); process.exit(1); });

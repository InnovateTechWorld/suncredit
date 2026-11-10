import express from 'express';
import PDFDocument from 'pdfkit';
import { q, audit } from '../db.js';
import { config } from '../config.js';
import { requireRole } from '../auth.js';
import { bad, notFound, conflict, parseJson } from '../util.js';
import { wrap } from './common.js';
import { stock, createOrder, refreshOrder, validateQuantity } from '../engine/sale.js';
import { gatewayPay } from '../adapters/mock.js';
import { adapterMode } from '../adapters/index.js';
import { friendly, AdapterError } from '../adapters/errors.js';

export const router = express.Router();
router.use(requireRole('buyer'));

router.get('/market', (_req, res) => res.json({ ...stock(), min: config.sale.minTonnes, reservation_minutes: config.sale.reservationMinutes }));

const orderOut = (o) => {
  const credits = q.all('SELECT serial,status,origin_month,region FROM credits WHERE order_id=? ORDER BY id', o.id);
  const cert = q.get('SELECT code,registry_ref,issued_at FROM certificates WHERE order_id=?', o.id);
  return {
    id: o.id, tonnes: o.tonnes, price_kobo: o.price_kobo, total_kobo: o.total_kobo, status: o.status, paid_kobo: o.paid_kobo,
    reserved_until: o.reserved_until, fail_reason: o.fail_reason, payment_ref: o.payment_ref, created_at: o.created_at,
    held_reason: o.status === 'held' ? (o.admin_flag === 'partial_payment' ? 'Your payment was less than the total. We are holding the order while an admin sorts it out. Nothing is lost.' : 'Your payment was more than the total. We are holding the order while an admin sorts it out. Nothing is lost.') : null,
    credits, certificate: cert || null, pay_path: o.payment_ref && o.status === 'awaiting_payment' ? `/pay/${o.payment_ref}` : null,
  };
};
const myOrder = (req) => {
  const o = q.get('SELECT * FROM orders WHERE id=? AND buyer_id=?', Number(req.params.id), req.user.id);
  if (!o) throw notFound('Order not found.');
  return o;
};

router.post('/orders', wrap(async (req, res) => {
  validateQuantity(req.body?.tonnes);
  try {
    const o = await createOrder(req.user, req.body.tonnes, req.headers['idempotency-key']);
    res.status(201).json({ order: orderOut(o) });
  } catch (e) {
    if (e instanceof AdapterError) { const f = friendly(e); return res.status(f.status).json({ error: f.code, message: f.message }); }
    throw e;
  }
}));
router.get('/orders', wrap((req, res) => res.json({ orders: q.all('SELECT * FROM orders WHERE buyer_id=? ORDER BY id DESC', req.user.id).map(orderOut) })));
router.get('/orders/:id', wrap(async (req, res) => {
  myOrder(req);
  const o = await refreshOrder(Number(req.params.id));
  res.json({ order: orderOut(o) });
}));

// The hosted payment step. In mock mode our own gateway answers; in sandbox mode the provider's page does.
router.get('/pay/:ref', wrap((req, res) => {
  const o = q.get('SELECT * FROM orders WHERE payment_ref=? AND buyer_id=?', req.params.ref, req.user.id);
  if (!o) throw notFound('Payment not found.');
  res.json({ order: orderOut(o), mode: adapterMode() });
}));
router.post('/pay/:ref', wrap(async (req, res) => {
  const o = q.get('SELECT * FROM orders WHERE payment_ref=? AND buyer_id=?', req.params.ref, req.user.id);
  if (!o) throw notFound('Payment not found.');
  if (o.status !== 'awaiting_payment') throw conflict('This order is not waiting for payment.', 'not_waiting');
  if (o.reserved_until < new Date().toISOString()) { await refreshOrder(o.id); throw conflict('The reservation expired before payment. Start again from the marketplace.', 'expired'); }
  audit(req.user, 'payment.attempted', 'order', o.id);
  const r = gatewayPay(req.params.ref);
  res.json({ result: r.status });
}));

router.get('/orders/:id/certificate.pdf', wrap((req, res) => {
  const o = myOrder(req);
  const cert = q.get('SELECT * FROM certificates WHERE order_id=?', o.id);
  if (!cert) throw conflict('The certificate is made once payment is confirmed.', 'not_ready');
  const credits = q.all('SELECT serial,origin_month,region FROM credits WHERE order_id=? ORDER BY id', o.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${cert.code}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: `Retirement certificate ${cert.code}` } });
  doc.pipe(res);
  doc.rect(28, 28, 539, 786).lineWidth(1).strokeColor('#2f4a3a').stroke();
  doc.fillColor('#1c2a22').font('Helvetica-Bold').fontSize(11).text('SUNCREDIT · NIGERIA SOLAR CARBON REGISTRY', 56, 70, { characterSpacing: 1.5 });
  doc.font('Helvetica-Bold').fontSize(30).text('Certificate of retirement', 56, 110);
  doc.font('Helvetica').fontSize(12).fillColor('#44564b').text(`This certifies that ${o.tonnes} tonne${o.tonnes > 1 ? 's' : ''} of CO₂ avoided by solar systems replacing diesel generators in Nigeria have been permanently retired.`, 56, 164, { width: 480, lineGap: 4 });
  doc.moveDown(2).font('Helvetica-Bold').fontSize(11).fillColor('#1c2a22').text(`Certificate  ${cert.code}`);
  doc.font('Helvetica').text(`Issued  ${new Date(cert.issued_at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })} WAT`);
  doc.text(`Registry reference  ${cert.registry_ref || '—'}`);
  doc.moveDown(1.2).font('Helvetica-Bold').text('Retired serial numbers');
  doc.font('Courier').fontSize(10);
  for (const c of credits.slice(0, 40)) doc.text(`${c.serial}   ${c.origin_month}   ${c.region}`);
  if (credits.length > 40) doc.text(`… and ${credits.length - 40} more`);
  doc.font('Helvetica').fontSize(10).fillColor('#44564b').text(`Verify any serial at /verify/<serial>. No personal data is published.`, 56, 760);
  doc.end();
}));

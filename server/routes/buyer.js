import express from 'express';
import { certificatePdf } from '../pdf.js';
import { q, audit } from '../db.js';
import { config } from '../config.js';
import { requireRole } from '../auth.js';
import { bad, notFound, conflict, parseJson } from '../util.js';
import { wrap } from './common.js';
import { stock, createOrder, refreshOrder, validateQuantity } from '../engine/sale.js';
import { gatewayPay } from '../adapters/mock.js';
import { adapterMode, paymentsLive, payments } from '../adapters/index.js';
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
  const fp = paymentsLive() ? q.get('SELECT payment_url FROM forge_payments WHERE ref=?', req.params.ref) : null;
  res.json({ order: orderOut(o), mode: adapterMode(), payment_url: fp?.payment_url || null, sandbox: paymentsLive() });
}));
router.post('/pay/:ref', wrap(async (req, res) => {
  const o = q.get('SELECT * FROM orders WHERE payment_ref=? AND buyer_id=?', req.params.ref, req.user.id);
  if (!o) throw notFound('Payment not found.');
  if (o.status !== 'awaiting_payment') throw conflict('This order is not waiting for payment.', 'not_waiting');
  if (o.reserved_until < new Date().toISOString()) { await refreshOrder(o.id); throw conflict('The reservation expired before payment. Start again from the marketplace.', 'expired'); }
  audit(req.user, 'payment.attempted', 'order', o.id);
  if (paymentsLive()) {
    // Sandbox stand-in for card + OTP. The result is never taken from this call: the order page verifies with the provider.
    await payments.simulate(req.params.ref, ['simulate-transfer', 'simulate-ussd', 'simulate-qr'].includes(req.body?.method) ? req.body.method : 'simulate-transfer');
    return res.json({ result: 'submitted' });
  }
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
  res.end(Buffer.from(certificatePdf({ code: cert.code, issuedText: `${new Date(cert.issued_at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })} WAT`, registryRef: cert.registry_ref, tonnes: o.tonnes, credits })));
}));

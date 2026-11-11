// Three interfaces, each with a mock and a sandbox implementation, picked per interface:
//   ADAPTER_MODE=mock|sandbox sets all of them; REGISTRY_MODE / PAYMENTS_MODE override one; DATASOURCE_MODE=csv (unchanged).
//
//   registry:   createProject, submitMeasurement, getStatus, review, retire, getCertificate
//   payments:   createCheckout, verifyPayment, nameEnquiry, transfer, requery (sandbox also: simulate)
//   datasource: parse (CSV today; the signed SunBox simulator feeds /device/ingest; there is no Forge equivalent)
// Every method is async and returns plain objects. Failures throw AdapterError with the same shape in both modes.
import { config } from '../config.js';
import { mockRegistry, mockPayments } from './mock.js';
import { sandboxRegistry, sandboxPayments } from './sandbox.js';
import { csvSource } from './datasource.js';

export { AdapterError } from './errors.js';

export const registry = config.registryMode === 'sandbox' ? sandboxRegistry : mockRegistry;
export const payments = config.paymentsMode === 'sandbox' ? sandboxPayments : mockPayments;
export const datasource = csvSource;
export const adapterModes = () => ({ registry: config.registryMode === 'sandbox' ? 'sandbox' : 'mock', payments: config.paymentsMode === 'sandbox' ? 'sandbox' : 'mock', datasource: config.datasourceMode });
export const adapterMode = () => { const m = adapterModes(); return m.registry === m.payments ? m.registry : `registry:${m.registry},payments:${m.payments}`; };
export const paymentsLive = () => config.paymentsMode === 'sandbox';

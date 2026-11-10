// Three interfaces, each with a mock and a sandbox implementation, picked by ADAPTER_MODE.
//
//   registry:   createProject, submitMeasurement, getStatus, review, retire, getCertificate
//   payments:   createCheckout, verifyPayment, nameEnquiry, transfer, requery
//   datasource: parse (CSV today; the SunBox feed slots in here later)
//
// Every method is async and returns plain objects. Failures throw AdapterError with the same shape in both modes.
import { config } from '../config.js';
import { mockRegistry, mockPayments } from './mock.js';
import { sandboxRegistry, sandboxPayments } from './sandbox.js';
import { csvSource } from './datasource.js';

export { AdapterError } from './errors.js';

const sandbox = config.adapterMode === 'sandbox';
export const registry = sandbox ? sandboxRegistry : mockRegistry;
export const payments = sandbox ? sandboxPayments : mockPayments;
export const datasource = csvSource;
export const adapterMode = () => (sandbox ? 'sandbox' : 'mock');

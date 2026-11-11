// Demo scenarios the sandbox understands. One-shot switches set by an admin, consumed by the next matching money call.
import { getSetting, setSetting } from '../db.js';

export const OUTCOMES = ['successful', 'failed', 'pending', 'timeout', 'reversed'];
export const AMOUNT_ENDINGS = { '01': 'insufficient funds', '02': 'timeout, then reversed', '03': 'pending for 2 minutes', '04': 'reversed after about 60 seconds', '05': 'withholds the first webhook' };
export const CATALOGUE = {
  outcome_header: 'Send header x-test-outcome: ' + OUTCOMES.join(' | ') + ' on the next payment simulation or transfer.',
  amount_endings: AMOUNT_ENDINGS,
  dup_reference: 'A reference starting DUP- returns the duplicate-reference error.',
  reject_review: 'Review a measurement with {"decision":"rejected","reason":"..."} to see the reject path.',
  reset: 'POST /admin/reset wipes this team\'s sandbox state (the app then rebuilds its copy).',
};
export const getScenario = () => ({ outcome: getSetting('forge.outcome', ''), ending: getSetting('forge.ending', ''), dup: getSetting('forge.dup', '0') === '1' });
export function setScenario({ outcome, ending, dup }) {
  if (outcome !== undefined) setSetting('forge.outcome', OUTCOMES.includes(outcome) ? outcome : '');
  if (ending !== undefined) setSetting('forge.ending', AMOUNT_ENDINGS[ending] ? ending : '');
  if (dup !== undefined) setSetting('forge.dup', dup ? '1' : '0');
}
// Read-and-clear, so a scenario fires once.
export function takeScenario(kind) {
  const s = getScenario();
  if (kind === 'payment') { setSetting('forge.outcome', ''); return { outcome: s.outcome || null }; }
  setSetting('forge.outcome', ''); setSetting('forge.ending', ''); setSetting('forge.dup', '0');
  return { outcome: s.outcome || null, ending: s.ending || null, dup: s.dup };
}

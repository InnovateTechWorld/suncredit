// Usage: npm run sunbox -- --site 4 --scenario normal --hours 24
// Posts signed SunBox batches to the running server (default http://127.0.0.1:3000).
import { sendScenario, SCENARIOS } from '../server/sunbox/simulator.js';
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith('--') ? [...acc, [v.slice(2), arr[i + 1]]] : acc), []));
if (!a.site) { console.log('Scenarios:\n' + Object.entries(SCENARIOS).map(([k, v]) => `  ${k.padEnd(16)} ${v}`).join('\n') + '\n\nnpm run sunbox -- --site <id> --scenario <name> --hours <n>'); process.exit(0); }
const out = await sendScenario(Number(a.site), a.scenario || 'normal', Number(a.hours) || 24);
console.log(JSON.stringify(out, null, 2)); process.exit(0);

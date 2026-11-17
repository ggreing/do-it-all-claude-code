// The status line of a subscription-mode run (set with --settings). It records only what the measurement needs, the
// rate_limits object and the model id, one JSON line per run of the status line, to the file named by its argument.
// Nothing else of the status line input (paths, session ids, transcript) is kept. If the file stays empty after a
// run, the status line did not run under -p: the pilot's first check.
import fs from 'node:fs';

const out = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(input);
    if (out) fs.appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), rate_limits: j.rate_limits ?? null, model: j.model?.id ?? null }) + '\n');
  } catch { /* not JSON: nothing to record */ }
  process.stdout.write('bench');
});

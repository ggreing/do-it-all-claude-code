// For tests that edit a role: the role's current text with some front matter keys or the body changed. The CLI
// edits the whole file, so a test that wants "the model, nothing else" builds the file this way.
import { parseDocument } from 'yaml';

export function withFields(current: string, fields: Record<string, unknown>): string {
  const m = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(current.replace(/\r\n/g, '\n'));
  if (!m) throw new Error('the role text has no front matter');
  const doc = parseDocument(m[1]!);
  let body = m[2] ?? '';
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'body') body = String(v);
    else if (k === 'x-router.verify') doc.setIn(['x-router', 'verify'], doc.createNode(v));
    else if (k === 'tools') doc.set('tools', Array.isArray(v) ? v.map(String).join(', ') : v);
    else doc.set(k, v);
  }
  return `---\n${doc.toString({ lineWidth: 0 }).replace(/\n+$/, '')}\n---\n${body}`;
}

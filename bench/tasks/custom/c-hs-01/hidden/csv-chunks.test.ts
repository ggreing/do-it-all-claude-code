import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CsvStream, DatakitError, parseCsv } from '../src/index.ts';

const DOCS: Array<[string, string[][]]> = [
  ['a,"b""c"\n', [['a', 'b"c']]],
  ['x\r\ny\r\n', [['x'], ['y']]],
  ['"a"\r\n"b"', [['a'], ['b']]],
  ['a,""\n', [['a', '']]],
  ['""""', [['"']]],
  ['"",""\r\n', [['', '']]],
  ['a\r\rb', [['a'], [''], ['b']]],
  ['a\n\nb', [['a'], [''], ['b']]],
  ['"line1\r\nline2",z\n', [['line1\r\nline2', 'z']]],
  ['"a""",b', [['a"', 'b']]],
  ['"a""b"', [['a"b']]],
  ['a,b\r', [['a', 'b']]],
  ['a,"b"', [['a', 'b']]],
  ['"x""""y",\r\n,"\r"\r\n', [['x""y', ''], ['', '\r']]],
  ['id,name\r\n1,"Kim, ""J"""\r\n2,\r\n', [['id', 'name'], ['1', 'Kim, "J"'], ['2', '']]],
];

/** Feeds the pieces to one stream and returns every row it gave. */
function feed(pieces: string[]): string[][] {
  const stream = new CsvStream();
  const rows: string[][] = [];
  for (const piece of pieces) rows.push(...stream.write(piece));
  rows.push(...stream.end());
  return rows;
}

test('the whole document at once', () => {
  for (const [doc, rows] of DOCS) assert.deepEqual(parseCsv(doc), rows, JSON.stringify(doc));
});

test('a document cut into two chunks at any position gives the same rows', () => {
  for (const [doc, rows] of DOCS) {
    for (let cut = 0; cut <= doc.length; cut++) {
      assert.deepEqual(feed([doc.slice(0, cut), doc.slice(cut)]), rows, `${JSON.stringify(doc)} cut at ${cut}`);
    }
  }
});

test('three chunks at any two positions, and one character at a time', () => {
  for (const [doc, rows] of DOCS) {
    for (let a = 0; a <= doc.length; a++) {
      for (let b = a; b <= doc.length; b++) {
        assert.deepEqual(feed([doc.slice(0, a), doc.slice(a, b), doc.slice(b)]), rows, `${JSON.stringify(doc)} cut at ${a} and ${b}`);
      }
    }
    assert.deepEqual(feed([...doc]), rows, `${JSON.stringify(doc)} character by character`);
  }
});

test('empty chunks between the pieces change nothing', () => {
  for (const [doc, rows] of DOCS) {
    assert.deepEqual(feed([...doc].flatMap(c => ['', c, ''])), rows, JSON.stringify(doc));
  }
});

test('rows are returned by the write that completed them', () => {
  const stream = new CsvStream();
  assert.deepEqual(stream.write('a,"b"'), []);
  assert.deepEqual(stream.write('"c"\n'), [['a', 'b"c']]);
  assert.deepEqual(stream.write('d,e\nf'), [['d', 'e']]);
  assert.deepEqual(stream.end(), [['f']]);
});

test('malformed input throws however it is cut, and the stream is usable afterwards', () => {
  for (const doc of ['"abc', 'x,"y""', '"a"b\n', '"a""b"c']) {
    for (let cut = 0; cut <= doc.length; cut++) {
      const stream = new CsvStream();
      assert.throws(() => { stream.write(doc.slice(0, cut)); stream.write(doc.slice(cut)); stream.end(); }, DatakitError, `${JSON.stringify(doc)} cut at ${cut}`);
    }
  }
  const stream = new CsvStream();
  stream.write('"open');
  assert.throws(() => stream.end(), DatakitError);
  assert.deepEqual([...stream.write('"q"'), ...stream.end()], [['q']]);
  assert.deepEqual([...stream.write('p\r'), ...stream.end(), ...stream.write('\nq'), ...stream.end()], [['p'], [''], ['q']]);
});

test('a custom delimiter is cut the same way', () => {
  const doc = 'a;"b;""c"""\r\n;\r\n';
  for (let cut = 0; cut <= doc.length; cut++) {
    const stream = new CsvStream({ delimiter: ';' });
    assert.deepEqual([...stream.write(doc.slice(0, cut)), ...stream.write(doc.slice(cut)), ...stream.end()], [['a', 'b;"c"'], ['', '']], `cut at ${cut}`);
  }
});

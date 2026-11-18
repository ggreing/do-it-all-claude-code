import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CsvStream, DatakitError, parseCsv } from '../src/index.ts';

test('parseCsv reads rows and fields', () => {
  assert.deepEqual(parseCsv('id,name\n1,Kim\n2,Lee\n'), [['id', 'name'], ['1', 'Kim'], ['2', 'Lee']]);
  assert.deepEqual(parseCsv('a,b'), [['a', 'b']]);
  assert.deepEqual(parseCsv(''), []);
});

test('quoted fields keep delimiters, line breaks and doubled quotes', () => {
  assert.deepEqual(parseCsv('1,"Kim, J."\n'), [['1', 'Kim, J.']]);
  assert.deepEqual(parseCsv('"two\nlines",x\n'), [['two\nlines', 'x']]);
  assert.deepEqual(parseCsv('a,"say ""hi"""\n'), [['a', 'say "hi"']]);
});

test('row ends: LF, CRLF and a lone CR; an empty line is a row with one empty field', () => {
  assert.deepEqual(parseCsv('a\r\nb\rc\n'), [['a'], ['b'], ['c']]);
  assert.deepEqual(parseCsv('a\n\nb\n'), [['a'], [''], ['b']]);
  assert.deepEqual(parseCsv('a,\n'), [['a', '']]);
});

test('a custom delimiter', () => {
  assert.deepEqual(parseCsv('a;b;"c;d"\n', { delimiter: ';' }), [['a', 'b', 'c;d']]);
  assert.throws(() => new CsvStream({ delimiter: '"' }), DatakitError);
});

test('malformed input throws', () => {
  assert.throws(() => parseCsv('"open'), DatakitError);
  assert.throws(() => parseCsv('"a"b\n'), DatakitError);
});

test('a document written in chunks', () => {
  const stream = new CsvStream();
  const rows = [...stream.write('id,name\n1,"Kim, J'), ...stream.write('."\n2,'), ...stream.write('Lee'), ...stream.end()];
  assert.deepEqual(rows, [['id', 'name'], ['1', 'Kim, J.'], ['2', 'Lee']]);
  // the stream is ready for another document after end()
  assert.deepEqual([...stream.write('x,y\n'), ...stream.end()], [['x', 'y']]);
});

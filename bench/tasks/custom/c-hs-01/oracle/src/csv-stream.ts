import { DatakitError } from './errors.ts';

export interface CsvOptions {
  /** Field separator, one character. Default `,`. */
  delimiter?: string;
}

type State = 'fieldStart' | 'unquoted' | 'quoted' | 'afterQuote';

/**
 * Parses CSV chunk by chunk. `write` returns the rows a chunk completed, `end` the last row when the input did
 * not end with a line break. See the README for the format.
 */
export class CsvStream {
  readonly #delimiter: string;
  #state: State = 'fieldStart';
  #field = '';
  #row: string[] = [];
  /** Whether anything of the current row has been read (a character, a quote or a delimiter). */
  #rowOpen = false;
  /** A `"` inside a quoted field was the last character of a chunk: the next character says what it was. */
  #quotePending = false;
  /** A `\r` that ended a row was the last character of a chunk: a `\n` right after it belongs to it. */
  #crPending = false;

  constructor(options: CsvOptions = {}) {
    const delimiter = options.delimiter ?? ',';
    if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
      throw new DatakitError('delimiter must be one character other than a quote or a line break');
    }
    this.#delimiter = delimiter;
  }

  write(chunk: string): string[][] {
    const rows: string[][] = [];
    if (chunk.length === 0) return rows;
    let i = 0;
    if (this.#quotePending) {
      this.#quotePending = false;
      if (chunk[0] === '"') { this.#field += '"'; i = 1; }
      else this.#state = 'afterQuote';
    } else if (this.#crPending) {
      this.#crPending = false;
      if (chunk[0] === '\n') i = 1;
    }
    for (; i < chunk.length; i++) {
      const c = chunk[i]!;
      const last = i === chunk.length - 1;
      if (this.#state === 'quoted') {
        if (c !== '"') this.#field += c;
        else if (last) this.#quotePending = true;
        else if (chunk[i + 1] === '"') { this.#field += '"'; i++; }
        else this.#state = 'afterQuote';
        continue;
      }
      if (c === '"' && this.#state === 'fieldStart') {
        this.#state = 'quoted';
        this.#rowOpen = true;
        continue;
      }
      if (c === this.#delimiter) {
        this.#row.push(this.#field);
        this.#field = '';
        this.#state = 'fieldStart';
        this.#rowOpen = true;
        continue;
      }
      if (c === '\n' || c === '\r') {
        if (c === '\r') {
          if (last) this.#crPending = true;
          else if (chunk[i + 1] === '\n') i++;
        }
        rows.push(this.#takeRow());
        continue;
      }
      if (this.#state === 'afterQuote') throw new DatakitError('unexpected character after a closing quote');
      this.#field += c;
      this.#state = 'unquoted';
      this.#rowOpen = true;
    }
    return rows;
  }

  end(): string[][] {
    // a quote the input ended on closed its field
    if (this.#quotePending) { this.#quotePending = false; this.#state = 'afterQuote'; }
    this.#crPending = false;
    if (this.#state === 'quoted') {
      this.#reset();
      throw new DatakitError('unterminated quoted field');
    }
    const rows = this.#rowOpen ? [this.#takeRow()] : [];
    this.#reset();
    return rows;
  }

  #takeRow(): string[] {
    const row = [...this.#row, this.#field];
    this.#reset();
    return row;
  }

  #reset(): void {
    this.#state = 'fieldStart';
    this.#field = '';
    this.#row = [];
    this.#rowOpen = false;
  }
}

/** Parses a whole CSV document. */
export function parseCsv(text: string, options: CsvOptions = {}): string[][] {
  const stream = new CsvStream(options);
  return [...stream.write(text), ...stream.end()];
}

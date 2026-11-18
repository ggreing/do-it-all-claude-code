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

  constructor(options: CsvOptions = {}) {
    const delimiter = options.delimiter ?? ',';
    if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
      throw new DatakitError('delimiter must be one character other than a quote or a line break');
    }
    this.#delimiter = delimiter;
  }

  write(chunk: string): string[][] {
    const rows: string[][] = [];
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      if (this.#state === 'quoted') {
        if (c !== '"') this.#field += c;
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
        if (c === '\r' && chunk[i + 1] === '\n') i++;
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

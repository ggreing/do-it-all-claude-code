// A plausible fix that is wrong: it handles the example in the report (a doubled quote split over two chunks)
// and nothing else. A `\r\n` split over two chunks still gives an extra row, and a quote that the input ends on
// is still pending when end() is called.
import { DatakitError } from './errors.ts';

export interface CsvOptions {
  delimiter?: string;
}

type State = 'fieldStart' | 'unquoted' | 'quoted' | 'afterQuote';

export class CsvStream {
  readonly #delimiter: string;
  #state: State = 'fieldStart';
  #field = '';
  #row: string[] = [];
  #rowOpen = false;
  #quotePending = false;

  constructor(options: CsvOptions = {}) {
    const delimiter = options.delimiter ?? ',';
    if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
      throw new DatakitError('delimiter must be one character other than a quote or a line break');
    }
    this.#delimiter = delimiter;
  }

  write(chunk: string): string[][] {
    const rows: string[][] = [];
    let i = 0;
    if (this.#quotePending && chunk.length > 0) {
      this.#quotePending = false;
      if (chunk[0] === '"') { this.#field += '"'; i = 1; }
      else this.#state = 'afterQuote';
    }
    for (; i < chunk.length; i++) {
      const c = chunk[i]!;
      if (this.#state === 'quoted') {
        if (c !== '"') this.#field += c;
        else if (i === chunk.length - 1) this.#quotePending = true;
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
      this.#quotePending = false;
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

export function parseCsv(text: string, options: CsvOptions = {}): string[][] {
  const stream = new CsvStream(options);
  return [...stream.write(text), ...stream.end()];
}

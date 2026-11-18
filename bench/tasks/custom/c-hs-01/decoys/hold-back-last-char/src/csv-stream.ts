// A plausible fix that is wrong: it keeps back a chunk's last character when that is a quote or a carriage
// return and puts it in front of the next chunk. Whether a quote is half of a doubled quote depends on the
// parser's state, not on the raw text: `"a""` + `b"` leaves `"a"` to be parsed first, and its second quote then
// looks like a closing one.
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
  #held = '';

  constructor(options: CsvOptions = {}) {
    const delimiter = options.delimiter ?? ',';
    if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
      throw new DatakitError('delimiter must be one character other than a quote or a line break');
    }
    this.#delimiter = delimiter;
  }

  write(chunk: string): string[][] {
    let text = this.#held + chunk;
    this.#held = '';
    const lastChar = text[text.length - 1];
    if (lastChar === '"' || lastChar === '\r') {
      this.#held = lastChar;
      text = text.slice(0, -1);
    }
    return this.#parse(text);
  }

  #parse(chunk: string): string[][] {
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
    const rows = this.#parse(this.#held);
    this.#held = '';
    if (this.#state === 'quoted') {
      this.#reset();
      throw new DatakitError('unterminated quoted field');
    }
    if (this.#rowOpen) rows.push(this.#takeRow());
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

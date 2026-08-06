export class ReadToolArgumentsError extends Error {
  constructor() {
    super("Read tool arguments must be a complete JSON object");
    this.name = "ReadToolArgumentsError";
  }
}

export interface ReadToolNormalizationResult {
  json: string;
  changed: boolean;
}

interface PropertyLocation {
  keyStart: number;
  valueEnd: number;
  commaBefore?: number;
  commaAfter?: number;
  remove: boolean;
}

type ParsedValue = { end: number; kind: "string"; value: string } | { end: number; kind: "other" };

interface ParsedString {
  end: number;
  value: string;
}

class JsonObjectScanner {
  readonly properties: PropertyLocation[] = [];
  readonly #maxDepth = 100;

  constructor(private readonly source: string) {}

  scan(): readonly PropertyLocation[] {
    const start = this.skipWhitespace(0);
    if (this.source[start] !== "{") {
      this.fail();
    }

    const end = this.parseObject(start, true, 1);
    if (this.skipWhitespace(end) !== this.source.length) {
      this.fail();
    }

    return this.properties;
  }

  private parseValue(index: number, depth: number): ParsedValue {
    if (depth > this.#maxDepth) {
      return this.fail();
    }
    const token = this.source[index];
    if (token === '"') {
      const parsed = this.parseString(index);
      return { end: parsed.end, kind: "string", value: parsed.value };
    }
    if (token === "{") {
      return { end: this.parseObject(index, false, depth), kind: "other" };
    }
    if (token === "[") {
      return { end: this.parseArray(index, depth), kind: "other" };
    }
    if (token === "t") {
      return { end: this.parseLiteral(index, "true"), kind: "other" };
    }
    if (token === "f") {
      return { end: this.parseLiteral(index, "false"), kind: "other" };
    }
    if (token === "n") {
      return { end: this.parseLiteral(index, "null"), kind: "other" };
    }
    if (token === "-" || this.isDigit(token)) {
      return { end: this.parseNumber(index), kind: "other" };
    }

    return this.fail();
  }

  private parseObject(index: number, captureProperties: boolean, depth: number): number {
    if (depth > this.#maxDepth) {
      return this.fail();
    }
    let cursor = this.skipWhitespace(index + 1);
    if (this.source[cursor] === "}") {
      return cursor + 1;
    }

    let commaBefore: number | undefined;
    while (cursor < this.source.length) {
      if (this.source[cursor] !== '"') {
        this.fail();
      }

      const keyStart = cursor;
      const key = this.parseString(cursor);
      cursor = this.skipWhitespace(key.end);
      if (this.source[cursor] !== ":") {
        this.fail();
      }

      cursor = this.skipWhitespace(cursor + 1);
      const value = this.parseValue(cursor, depth + 1);
      const valueEnd = value.end;
      cursor = this.skipWhitespace(valueEnd);

      let commaAfter: number | undefined;
      if (this.source[cursor] === ",") {
        commaAfter = cursor;
      } else if (this.source[cursor] !== "}") {
        this.fail();
      }

      if (captureProperties) {
        this.properties.push({
          keyStart,
          valueEnd,
          ...(commaBefore === undefined ? {} : { commaBefore }),
          ...(commaAfter === undefined ? {} : { commaAfter }),
          remove: key.value === "pages" && value.kind === "string" && value.value === "",
        });
      }

      if (commaAfter === undefined) {
        return cursor + 1;
      }

      commaBefore = commaAfter;
      cursor = this.skipWhitespace(commaAfter + 1);
    }

    return this.fail();
  }

  private parseArray(index: number, depth: number): number {
    if (depth > this.#maxDepth) {
      return this.fail();
    }
    let cursor = this.skipWhitespace(index + 1);
    if (this.source[cursor] === "]") {
      return cursor + 1;
    }

    while (cursor < this.source.length) {
      const value = this.parseValue(cursor, depth + 1);
      cursor = this.skipWhitespace(value.end);
      if (this.source[cursor] === "]") {
        return cursor + 1;
      }
      if (this.source[cursor] !== ",") {
        this.fail();
      }
      cursor = this.skipWhitespace(cursor + 1);
    }

    return this.fail();
  }

  private parseString(index: number): ParsedString {
    let cursor = index + 1;
    while (cursor < this.source.length) {
      const character = this.source[cursor];
      if (character === '"') {
        const end = cursor + 1;
        try {
          return { end, value: JSON.parse(this.source.slice(index, end)) as string };
        } catch {
          return this.fail();
        }
      }
      if (character === "\\") {
        const escapeCharacter = this.source[cursor + 1];
        if (escapeCharacter === "u") {
          for (let offset = 2; offset < 6; offset += 1) {
            if (!this.isHexDigit(this.source[cursor + offset])) {
              this.fail();
            }
          }
          cursor += 6;
          continue;
        }
        if (escapeCharacter === undefined || !'"\\/bfnrt'.includes(escapeCharacter)) {
          this.fail();
        }
        cursor += 2;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) <= 0x1f) {
        this.fail();
      }
      cursor += 1;
    }

    return this.fail();
  }

  private parseLiteral(index: number, literal: string): number {
    if (this.source.slice(index, index + literal.length) !== literal) {
      this.fail();
    }
    return index + literal.length;
  }

  private parseNumber(index: number): number {
    let cursor = index;
    if (this.source[cursor] === "-") {
      cursor += 1;
    }

    if (this.source[cursor] === "0") {
      cursor += 1;
    } else {
      if (!this.isNonZeroDigit(this.source[cursor])) {
        return this.fail();
      }
      cursor += 1;
      while (this.isDigit(this.source[cursor])) {
        cursor += 1;
      }
    }

    if (this.source[cursor] === ".") {
      cursor += 1;
      if (!this.isDigit(this.source[cursor])) {
        return this.fail();
      }
      while (this.isDigit(this.source[cursor])) {
        cursor += 1;
      }
    }

    if (this.source[cursor] === "e" || this.source[cursor] === "E") {
      cursor += 1;
      if (this.source[cursor] === "+" || this.source[cursor] === "-") {
        cursor += 1;
      }
      if (!this.isDigit(this.source[cursor])) {
        return this.fail();
      }
      while (this.isDigit(this.source[cursor])) {
        cursor += 1;
      }
    }

    return cursor;
  }

  private skipWhitespace(index: number): number {
    let cursor = index;
    while (
      this.source[cursor] === " " ||
      this.source[cursor] === "\t" ||
      this.source[cursor] === "\n" ||
      this.source[cursor] === "\r"
    ) {
      cursor += 1;
    }
    return cursor;
  }

  private isDigit(character: string | undefined): boolean {
    return character !== undefined && character >= "0" && character <= "9";
  }

  private isNonZeroDigit(character: string | undefined): boolean {
    return character !== undefined && character >= "1" && character <= "9";
  }

  private isHexDigit(character: string | undefined): boolean {
    return character !== undefined && /^[0-9a-f]$/i.test(character);
  }

  private fail(): never {
    throw new ReadToolArgumentsError();
  }
}

export function normalizeReadToolArguments(
  name: string,
  raw: string,
  enabled: boolean,
): ReadToolNormalizationResult {
  if (!enabled || !/^read$/i.test(name)) {
    return { json: raw, changed: false };
  }

  const properties = new JsonObjectScanner(raw).scan();
  const ranges = getRemovalRanges(properties);
  if (ranges.length === 0) {
    return { json: raw, changed: false };
  }

  let json = raw;
  for (const range of ranges.reverse()) {
    json = json.slice(0, range.start) + json.slice(range.end);
  }
  return { json, changed: true };
}

interface RemovalRange {
  start: number;
  end: number;
}

function getRemovalRanges(properties: readonly PropertyLocation[]): RemovalRange[] {
  const ranges: RemovalRange[] = [];
  let index = 0;
  while (index < properties.length) {
    const first = properties[index];
    if (!first?.remove) {
      index += 1;
      continue;
    }

    let lastIndex = index;
    while (properties[lastIndex + 1]?.remove) {
      lastIndex += 1;
    }
    const last = properties[lastIndex];
    if (!last) {
      break;
    }

    const trailing = lastIndex === properties.length - 1;
    ranges.push({
      start: trailing && first.commaBefore !== undefined ? first.commaBefore : first.keyStart,
      end: trailing ? last.valueEnd : (last.commaAfter ?? last.valueEnd) + 1,
    });
    index = lastIndex + 1;
  }
  return ranges;
}

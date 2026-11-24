import { readFileSync } from "fs";
import { readFile } from "fs/promises";

/**
 * The text of bytes a tool saved as a manifest or config file: UTF-8 with or without a byte-order mark, UTF-16 by
 * its mark (little or big endian, surrogate pairs included), else UTF-8. Windows PowerShell 5.1's `>` writes
 * UTF-16 LE with a mark, and a UTF-8 read of it is a string of NULs between the letters that no manifest reader
 * recognizes. A UTF-16 file without a mark is not told apart from binary and reads as UTF-8.
 */
export function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      const swapped = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
      swapped.swap16();
      return swapped.toString("utf16le");
    }
  }
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Source text: UTF-16 by its mark (Visual Studio and PowerShell ISE write it), else the bytes as UTF-8 exactly as
 * `readFile(path, "utf-8")` returns them — a UTF-8 mark stays, `normalizeSource` strips it where a parser needs it.
 */
export function decodeSource(bytes: Buffer): string {
  const utf16 = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  return utf16 ? decodeText(bytes) : bytes.toString("utf8");
}

export async function readSourceText(path: string): Promise<string> {
  return decodeSource(await readFile(path));
}

export function readSourceTextSync(path: string): string {
  return decodeSource(readFileSync(path));
}

export async function readTextFile(path: string): Promise<string> {
  return decodeText(await readFile(path));
}

export function readTextFileSync(path: string): string {
  return decodeText(readFileSync(path));
}

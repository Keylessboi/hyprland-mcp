/**
 * OCR — read text from a screenshot via tesseract.
 *
 * Purely desktop-interaction: the agent needs to know what text is on screen
 * to target it (click_text, wait_for text). System-side concerns stay in the
 * shell. Tesseract runs as a subprocess against a temp PNG; output is TSV,
 * which gives word-level boxes in PIXEL space. The caller maps pixels to
 * logical coordinates (region origin + px/scale).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type ScreenshotBackend } from './screenshot.js';
import { HyprError } from './types.js';

export interface OcrWord {
  text: string;
  /** Pixel-space box within the captured image. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** tesseract confidence 0..100; low-confidence words are filtered upstream. */
  confidence: number;
}

export interface OcrResult {
  /** The full recognized text (line-ordered). */
  text: string;
  /** Word boxes in pixel space, ordered top-to-bottom, left-to-right. */
  words: OcrWord[];
}

const MIN_CONFIDENCE = 60;

/** Parse tesseract TSV output. Skips the header and non-word rows. */
export function parseTsv(csv: string): OcrWord[] {
  const lines = csv.split('\n');
  if (!lines[0]!.startsWith('level'))
    return [];
  const words: OcrWord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split('\t');
    if (cols.length < 12)
      continue;
    const level = Number(cols[0]);
    if (level !== 5) // word rows only
      continue;
    const text = cols[11] ?? '';
    if (!text.trim())
      continue;
    const confidence = Number(cols[10]);
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE)
      continue;
    words.push({
      text,
      left: Number(cols[6]) || 0,
      top: Number(cols[7]) || 0,
      width: Number(cols[8]) || 0,
      height: Number(cols[9]) || 0,
      confidence,
    });
  }
  return words;
}

/** Assemble word boxes into a readable text with line breaks. */
export function wordsToText(words: OcrWord[]): string {
  // group words into lines by vertical proximity
  const sorted = [...words].sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: OcrWord[][] = [];
  for (const w of sorted) {
    const cur = lines.at(-1);
    if (cur && Math.abs(w.top - cur[0]!.top) <= Math.max(2, cur[0]!.height * 0.6)) {
      cur.push(w);
    } else {
      lines.push([w]);
    }
  }
  return lines.map((ln) => ln.sort((a, b) => a.left - b.left).map((w) => w.text).join(' ')).join('\n');
}

export class OcrEngine {
  constructor(private runner: ScreenshotBackend) {}

  /** OCR a PNG/JPEG buffer. Returns words in PIXEL space (caller maps coords). */
  async readImage(image: Buffer, opts: { language?: string; timeoutMs?: number } = {}): Promise<OcrResult> {
    const lang = opts.language ?? 'eng';
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hypr-ocr-'));
    const file = path.join(dir, 'capture.png');
    try {
      await writeFile(file, image);
      const { stdout, code } = await this.runner.run('tesseract', [file, 'stdout', '-l', lang, 'tsv'], { timeoutMs });
      if (code !== 0)
        throw new HyprError('OCR_FAILED', `tesseract exited ${code ?? 'nonzero'}`);
      const words = parseTsv(stdout.toString('utf8'));
      return { text: wordsToText(words), words };
    } catch (e) {
      if (e instanceof HyprError)
        throw e;
      throw new HyprError('OCR_FAILED', `tesseract failed: ${(e as Error).message}`, { hint: 'Is tesseract installed? (Arch: sudo pacman -S tesseract)' });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Redaction for container stderr before it is stored. The container never holds a Cloudflare
 * token, so this is defence in depth: exact values the runner knows are secret (the state
 * passphrase) are always removed, and anything token-shaped is masked.
 *
 * Works line by line on a stream of text. A line longer than `maxLine` is cut at a character that
 * cannot be part of a token, so a secret is never split across two separately scanned pieces.
 */

const MASK = '[REDACTED]';

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // HTTP authorization headers in any client's debug output.
  [/\b((?:proxy-)?authorization)(\s*[:=]\s*)[^\r\n]+/gi, `$1$2${MASK}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, `Bearer ${MASK}`],
  // GitHub tokens (classic, fine-grained, installation, OAuth, refresh).
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, MASK],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, MASK],
  // SigV4 material in URLs or headers.
  [/\b(X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Signature|Credential)=[^&\s"',]+/g, `$1=${MASK}`],
  // key=value or key: value where the key names a secret.
  [/\b([A-Za-z0-9_]*(?:passphrase|password|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*)(\s*["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi, `$1$2${MASK}`],
];

/**
 * Generic high-entropy runs: base64/base64url of 32+ characters mixing upper case, lower case and
 * digits. Lowercase hex (commit and SHA-256 digests) does not match, so logs stay debuggable.
 */
function maskGeneric(text: string): string {
  return text.replace(/[A-Za-z0-9_+/-]{32,}={0,2}/g, (run) => (/[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run) ? MASK : run));
}

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

export class Redactor {
  private readonly exact: string[];
  private readonly maxLine: number;
  private pending = '';
  private inPem = false;

  constructor(exactSecrets: readonly string[], maxLine = 16 * 1024) {
    // Longest first so a secret that contains another is removed whole.
    this.exact = exactSecrets.filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
    this.maxLine = maxLine;
  }

  /** Feed text; returns the redacted complete lines (with their newlines) that are safe to emit. */
  push(text: string): string {
    this.pending += text;
    let out = '';
    for (;;) {
      const newline = this.pending.indexOf('\n');
      if (newline !== -1) {
        out += this.line(this.pending.slice(0, newline)) + '\n';
        this.pending = this.pending.slice(newline + 1);
        continue;
      }
      if (this.pending.length <= this.maxLine) break;
      const cut = safeCut(this.pending, this.maxLine);
      out += this.line(this.pending.slice(0, cut));
      this.pending = this.pending.slice(cut);
    }
    return out;
  }

  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return rest === '' ? '' : this.line(rest);
  }

  private line(text: string): string {
    if (this.inPem || PEM_BEGIN.test(text)) {
      this.inPem = !PEM_END.test(text);
      return MASK;
    }
    let out = text;
    for (const secret of this.exact) out = out.split(secret).join(MASK);
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return maskGeneric(out);
  }
}

/** Cut before `limit` at the last character outside the token alphabet; if none, cut anywhere (the run is masked). */
function safeCut(text: string, limit: number): number {
  for (let i = limit; i > limit / 2; i--) {
    if (!/[A-Za-z0-9_+/=.~-]/.test(text[i - 1] ?? '')) return i;
  }
  return limit;
}

/** One-shot convenience for short strings. */
export function redactText(text: string, exactSecrets: readonly string[] = []): string {
  const r = new Redactor(exactSecrets);
  return r.push(text) + r.flush();
}

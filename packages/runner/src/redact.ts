// Defense in depth: secret values handed to a job are scrubbed from anything the controller writes.

/** Values shorter than this are not redacted: they are not credentials and would blank ordinary words. */
export const MIN_REDACTED_LENGTH = 8;

export interface Redactor {
  apply(text: string): string;
}

export function createRedactor(secrets: Readonly<Record<string, string>>): Redactor {
  const entries = Object.entries(secrets)
    .filter(([, value]) => value.length >= MIN_REDACTED_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
  return {
    apply(text: string): string {
      let out = text;
      for (const [name, value] of entries) out = out.split(value).join(`[redacted:${name}]`);
      return out;
    },
  };
}

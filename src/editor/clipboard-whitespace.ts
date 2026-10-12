/** HTML collapses inline whitespace to a single space, including a text-only node. */
export function inlineWhitespace(value: string, pre?: boolean, trim?: boolean) {
  return !pre && !trim && /^[\t\n\r\f ]+$/.test(value) ? ' ' : undefined;
}

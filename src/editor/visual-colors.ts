/** Resolve modern CSS colors through the browser before html2canvas 1.4.1
 * parses them. Only the inert export clone receives these declarations. */
export function normalizeVisualColors(element: HTMLElement) {
  const doc = element.ownerDocument, view = doc.defaultView;
  if (!view) throw new Error('导出页面无法读取');
  const canvas = doc.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法读取导出颜色');
  const colors = new Map<string, string>();
  const convert = (value: string) => {
    let converted = colors.get(value);
    if (!converted) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#010203'; context.fillStyle = value;
      const first = context.fillStyle;
      context.fillStyle = '#040506'; context.fillStyle = value;
      if (first !== context.fillStyle) throw new Error('浏览器无法转换导出颜色');
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
      converted = `rgba(${r}, ${g}, ${b}, ${alpha / 255})`; colors.set(value, converted);
    }
    return converted;
  };
  const pattern = /\b(?:oklab|oklch|lab|lch|color|color-mix)\(/g;
  const replaceColors = (value: string) => {
    let output = '', from = 0, match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(value))) {
      let depth = 1, end = pattern.lastIndex;
      while (end < value.length && depth) { if (value[end] === '(') depth++; if (value[end] === ')') depth--; end++; }
      if (depth) throw new Error('导出颜色无法解析');
      output += value.slice(from, match.index) + convert(value.slice(match.index, end));
      from = end; pattern.lastIndex = end;
    }
    return output + value.slice(from);
  };
  for (const node of new Set([doc.documentElement, doc.body, element, ...element.querySelectorAll<HTMLElement>('*')])) {
    const computed = view.getComputedStyle(node);
    const updates: [string, string][] = [];
    for (const property of Array.from(computed)) {
      if (!/color|shadow|background-image/.test(property)) continue;
      const value = computed.getPropertyValue(property);
      pattern.lastIndex = 0;
      if (pattern.test(value)) updates.push([property, replaceColors(value)]);
    }
    for (const [property, value] of updates) node.style.setProperty(property, value, 'important');
  }
}

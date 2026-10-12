/** Bound both dimensions and pixel area before allocating a PDF page canvas. */
export function pdfPageScale(width: number, height: number, availableWidth: number, density = 1) {
  if (![width, height, availableWidth, density].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid PDF page dimensions');
  return Math.min(Math.min(availableWidth, 900) / width * Math.min(density, 2), 4096 / width, 4096 / height, Math.sqrt(4_000_000 / (width * height)));
}

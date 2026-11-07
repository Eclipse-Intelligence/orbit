export const SIGNATURE_WIDTH_MAX = 2400;
export const SIGNATURE_HEIGHT_MAX = 1200;

export function signatureScale(width: number, height: number, ratio: number) {
  if (!(width > 0) || !(height > 0)) return 0;
  const wanted = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  return Math.min(wanted, SIGNATURE_WIDTH_MAX / width, SIGNATURE_HEIGHT_MAX / height);
}

export function signatureCanvasSize(width: number, height: number, ratio: number) {
  const scale = signatureScale(width, height, ratio);
  return {
    scale,
    width: Math.min(SIGNATURE_WIDTH_MAX, Math.round(width * scale)),
    height: Math.min(SIGNATURE_HEIGHT_MAX, Math.round(height * scale)),
  };
}

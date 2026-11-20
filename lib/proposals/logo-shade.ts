export function isDarkLogo(rgba: ArrayLike<number>) {
  let weight = 0;
  let light = 0;
  for (let index = 0; index + 3 < rgba.length; index += 4) {
    const alpha = rgba[index + 3] / 255;
    if (alpha < 0.12) continue;
    const luminance = (0.2126 * rgba[index] + 0.7152 * rgba[index + 1] + 0.0722 * rgba[index + 2]) / 255;
    weight += alpha;
    light += luminance * alpha;
  }
  if (weight === 0) return false;
  return light / weight < 0.55;
}

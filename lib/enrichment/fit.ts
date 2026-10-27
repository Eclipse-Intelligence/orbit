export const FIT_LABELS = ["Not a fit", "Weak fit", "Partial fit", "Good fit", "Strong fit"];

export function fitLabel(score: number) {
  return FIT_LABELS[Math.min(FIT_LABELS.length - 1, Math.max(0, Math.round(score)))];
}

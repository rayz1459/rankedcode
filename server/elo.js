export function expectedScore(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function computeEloUpdate({
  eloA,
  eloB,
  scoreA,
  scoreB,
  runtimeA,
  runtimeB
}) {
  const expectedA = expectedScore(eloA, eloB);
  const expectedB = expectedScore(eloB, eloA);

  const baseK = 32;
  let kMultiplier = 1;

  if (runtimeA != null && runtimeB != null && runtimeA > 0 && runtimeB > 0) {
    const ratio = runtimeB / runtimeA;
    kMultiplier = clamp(ratio, 0.75, 1.5);
  }

  const k = Math.round(baseK * kMultiplier);
  const newEloA = Math.round(eloA + k * (scoreA - expectedA));
  const newEloB = Math.round(eloB + k * (scoreB - expectedB));

  return { newEloA, newEloB, k };
}

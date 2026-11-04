// "Not loaded" is not "none". A membership/credit read that FAILED is passed
// around as `undefined`; a confirmed answer is a membership object, `null`
// (no membership) or a credits array (possibly empty). Rendering must show
// nothing for unknown, never "No Membership" or "0 credits".
export function isBenefitUnknown(gym, membership, credits) {
  if (membership) return false;                 // a real membership is always known
  const metered = gym?.capabilities?.metered !== false;
  if (metered) return credits === undefined;    // a metered gym answers with credits
  return membership === undefined;              // a membership gym answers with membership
}

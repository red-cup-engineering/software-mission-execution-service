export const DIRECT_WITNESS_SETTLEMENT_CAPABILITY = "urn:union:settlement-capability:direct-witness-v1";
export const RESOLUTION_CREDIT_ASSET = "urn:union:credit:relative-resolution-milliquanta-v1";
export const RESOLUTION_CREDIT_UNIT = "relative-resolution-milliquanta-v1";

export function validateConsiderationPolicy(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || value.type !== "ConsiderationPolicy"
      || !Array.isArray(value.acceptableAlternatives) || value.acceptableAlternatives.length === 0) {
    throw new Error("consideration policy requires ordered acceptable alternatives");
  }
  const alternatives = value.acceptableAlternatives.map((alternative) => {
    if (typeof alternative?.id !== "string" || alternative.id === "" || !Array.isArray(alternative.obligations) || alternative.obligations.length === 0) throw new Error("consideration alternative is malformed");
    const obligations = alternative.obligations.map((obligation) => {
      if (!obligation || !["credit", "currency", "resource", "service"].includes(obligation.kind)
          || typeof obligation.asset !== "string" || typeof obligation.unit !== "string"
          || !Array.isArray(obligation.settlementCapabilities) || obligation.settlementCapabilities.length === 0
          || obligation.settlementCapabilities.some((capability) => typeof capability !== "string" || !capability.startsWith("urn:"))) {
        throw new Error("acceptable consideration obligation is malformed");
      }
      return Object.freeze({ ...obligation, settlementCapabilities: Object.freeze([...obligation.settlementCapabilities]) });
    });
    return Object.freeze({ ...alternative, obligations: Object.freeze(obligations) });
  });
  return Object.freeze({ type: "ConsiderationPolicy", acceptableAlternatives: Object.freeze(alternatives) });
}

export function resolutionCreditPolicy() {
  return validateConsiderationPolicy({
    type: "ConsiderationPolicy",
    acceptableAlternatives: [{
      id: "resolution-credit",
      obligations: [{
        kind: "credit",
        asset: RESOLUTION_CREDIT_ASSET,
        unit: RESOLUTION_CREDIT_UNIT,
        settlementCapabilities: [DIRECT_WITNESS_SETTLEMENT_CAPABILITY],
      }],
    }],
  });
}

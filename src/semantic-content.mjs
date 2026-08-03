import { EMPTY_WITNESS_ROOT, admitNormalizedSemanticContent, identifyNormalizedSemanticContent } from "@red-cup-engineering/semantic-content-identify-service";
import { jsonToTerm, termToJson } from "@red-cup-engineering/relation-model-notation-json-codec";
import { inferTy } from "@red-cup-engineering/relation-model-notation-typing";

export const OPERATION_KIND = "software-mission-execution.operation";

export function identifyOperation(value) {
  const term = jsonToTerm(value), semanticType = inferTy([], term);
  if (semanticType === null) throw new TypeError("software mission operation did not derive an RMN type");
  return identifyNormalizedSemanticContent({ objectKind: OPERATION_KIND, semanticType, term, witnessRoot: EMPTY_WITNESS_ROOT });
}

export function operationFromSemanticBytes(bytes) {
  const admitted = admitNormalizedSemanticContent(bytes);
  if (admitted.envelope.objectKind !== OPERATION_KIND) throw new TypeError("software mission operation has the wrong semantic kind");
  return termToJson(admitted.envelope.settledBody);
}

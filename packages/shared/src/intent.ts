import { hashCanonical } from "./canonical";
import { IntentSchema, type IntentBody, type TransactionIntent } from "./types";

const INTENT_DOMAIN = "duplachave/intent/v1";

/** Hash canônico da intenção (sem o campo intentHash). */
export function computeIntentHash(body: IntentBody): string {
  const parsed = IntentSchema.parse(body);
  return hashCanonical({ domain: INTENT_DOMAIN, intent: parsed });
}

export function sealIntent(body: IntentBody): TransactionIntent {
  return { ...body, intentHash: computeIntentHash(body) } as TransactionIntent;
}

export function intentBody(intent: TransactionIntent): IntentBody {
  const { intentHash: _ignored, ...body } = intent;
  return body as IntentBody;
}

export function verifyIntentHash(intent: TransactionIntent): boolean {
  return computeIntentHash(intentBody(intent)) === intent.intentHash;
}

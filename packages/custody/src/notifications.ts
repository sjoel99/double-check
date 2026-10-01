export type NotificationTarget = { userId: string; accountId: string };

export interface NotificationService {
  transactionApprovalRequested(t: NotificationTarget, p: { intentId: string; summary: string }): Promise<void>;
  keyRotationRequested(t: NotificationTarget, p: { rotationId: string; role: "CLIENT" | "SERVER"; summary: string }): Promise<void>;
  securityAlert(t: NotificationTarget, p: { code: string; message: string }): Promise<void>;
}

/**
 * Mock: registra em memória e no log. Uma notificação nunca carrega dado que
 * autorize algo — ela só avisa; o app sempre busca e confere na chain.
 */
export class LogNotificationService implements NotificationService {
  readonly sent: { kind: string; target: NotificationTarget; payload: unknown }[] = [];
  constructor(private readonly log: (msg: string) => void = () => {}) {}
  private push(kind: string, target: NotificationTarget, payload: unknown) {
    this.sent.push({ kind, target, payload });
    this.log(`[notificação] ${kind} ${JSON.stringify(payload)}`);
  }
  async transactionApprovalRequested(t: NotificationTarget, p: { intentId: string; summary: string }) { this.push("transactionApprovalRequested", t, p); }
  async keyRotationRequested(t: NotificationTarget, p: { rotationId: string; role: "CLIENT" | "SERVER"; summary: string }) { this.push("keyRotationRequested", t, p); }
  async securityAlert(t: NotificationTarget, p: { code: string; message: string }) { this.push("securityAlert", t, p); }
}

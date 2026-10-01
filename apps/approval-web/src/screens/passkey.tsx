import { useCallback, useEffect, useState } from "react";
import { activatePasskey, errorText, useApp } from "../app";
import { api } from "../lib/api";
import { Icon } from "../icons";

export type PasskeyView = { id: string; deviceName: string; rpId: string; createdAt: number; activeAt: number; revokedAt: number | null };

/** Biometrias da conta. `active` = alguma já vale neste domínio. */
export function usePasskeys() {
  const ctx = useApp();
  const [list, setList] = useState<PasskeyView[] | null>(null);
  const load = useCallback(async () => {
    if (!ctx.session) return;
    try {
      setList((await api<{ passkeys: PasskeyView[] }>("GET", `/v1/accounts/${ctx.session.accountId}/passkeys`)).passkeys);
    } catch {
      /* tenta de novo depois */
    }
  }, [ctx.session]);
  useEffect(() => {
    void load();
  }, [load]);
  const now = Date.now() / 1000;
  const here = (list ?? []).filter((p) => p.revokedAt === null && p.rpId === location.hostname);
  return { list, reload: load, active: here.some((p) => p.activeAt <= now), pending: here.find((p) => p.activeAt > now) ?? null };
}

const when = (t: number) => new Date(t * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

/** Ativar a confirmação por biometria neste aparelho. Sem ela, o serviço não assina nada. */
export function PasskeySetup({ then = "/" }: { then?: string }) {
  const ctx = useApp();
  const { list, active, pending, reload } = usePasskeys();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ status: "ACTIVE" | "PENDING"; activeAt: number } | null>(null);

  const run = async () => {
    setErr(null);
    try {
      const c = await ctx.accountWallet();
      const out = await activatePasskey(ctx, c, setBusy);
      setDone(out);
      await reload();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const first = list !== null && list.length === 0;
  return (
    <>
      <div className="topbar">
        <button type="button" className="iconbtn" aria-label="Voltar" onClick={() => ctx.go("/")}>
          <Icon name="back" />
        </button>
        <h1>Biometria</h1>
      </div>
      <div className="page">
        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4 }}>
          <div className="key-ico" style={{ width: 52, height: 52 }}>
            <Icon name="finger" size={24} color="#C8F169" />
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.2 }}>Confirme cada transação com a sua digital ou rosto.</div>
          <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
            Antes de abrir a carteira, o app mostra o que vai ser assinado e pede a biometria deste aparelho. O serviço só assina a parte dele depois dela — e ela fica presa àquela transação exata.
          </div>
        </div>

        {done?.status === "ACTIVE" || (active && !done) ? (
          <div className="banner ok">
            <Icon name="check" size={18} color="var(--accent)" />
            <div>Biometria ativa neste aparelho.</div>
          </div>
        ) : done?.status === "PENDING" || pending ? (
          <div className="banner warn">
            <Icon name="clock" size={18} color="#F2B33D" />
            <div>
              Biometria vinculada, mas nenhuma outra biometria ativa aprovou. Por segurança, ela passa a valer em <b>{when(done?.activeAt ?? pending!.activeAt)}</b>. Se não foi você, troque a carteira da conta.
            </div>
          </div>
        ) : null}

        <div className="card" style={{ gap: 8 }}>
          <div className="muted" style={{ fontSize: 13 }}>Como funciona</div>
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>1. Este aparelho cria uma chave de biometria (ela nunca sai dele).</div>
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>2. A sua {ctx.session!.walletName} assina um texto vinculando essa biometria à conta.</div>
          {!first && <div style={{ fontSize: 14, lineHeight: 1.5 }}>3. Uma biometria já ativa aprova a nova; sem isso, a nova espera um prazo.</div>}
        </div>

        {(list ?? []).length > 0 && (
          <div>
            <div className="section-title" style={{ paddingBottom: 4 }}>
              Biometrias da conta
            </div>
            {list!.map((p) => (
              <div className="list-row" key={p.id} style={{ borderTop: "1px solid var(--line-soft)" }}>
                <div className="ico" style={{ background: "var(--surface-2)", width: 40, height: 40 }}>
                  <Icon name="lock" size={18} color="var(--muted)" />
                </div>
                <div className="grow">
                  <div className="t">{p.deviceName}</div>
                  <div className="s">
                    {p.rpId} · desde {when(p.createdAt)}
                  </div>
                </div>
                <span className={`pill ${p.activeAt > Date.now() / 1000 ? "warn" : ""}`}>{p.revokedAt ? "revogada" : p.activeAt > Date.now() / 1000 ? "aguardando" : "ativa"}</span>
              </div>
            ))}
          </div>
        )}
        {busy && (
          <div className="status">
            <span className="spinner" /> {busy}
          </div>
        )}
        {err && <div className="banner danger">{err}</div>}
      </div>
      <div className="actions">
        {done || active ? (
          <button type="button" className="btn primary" onClick={() => ctx.go(then)}>
            Continuar
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={Boolean(busy)} onClick={run}>
            {busy ? <span className="spinner" /> : <Icon name="finger" color="#0B0D10" sw={2} />} Ativar biometria neste aparelho
          </button>
        )}
      </div>
    </>
  );
}

// Grava a demo do Double Check (localnet) com legendas em inglês.
// Uso: pnpm dev (em outro terminal) e depois node colosseum/record-demo.cjs
// Precisa do Playwright (npm i -g playwright ou PLAYWRIGHT=<caminho>); CHROME=<binário> opcional.
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const W = 1600, H = 900;
const DEST = 'Bnu1zsZmW3iX2jcrBVHPzhG9Wv6cMDKhsvqhqXKmoTBk';

const OVERLAY = `
(() => {
  const css = \`
  #dc-cap{position:fixed;left:48px;top:50%;transform:translateY(-50%);width:470px;z-index:2147483646;
    font-family:Inter,system-ui,sans-serif;color:#e8ecef;pointer-events:none;transition:opacity .35s}
  #dc-cap .k{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#c8f26a;font-weight:700;margin-bottom:14px}
  #dc-cap .t{font-size:34px;line-height:1.18;font-weight:700;margin-bottom:16px}
  #dc-cap .b{font-size:20px;line-height:1.5;color:#b7c0c8}
  #dc-cap .b b{color:#fff}
  #dc-side{position:fixed;right:48px;top:50%;transform:translateY(-50%);width:440px;z-index:2147483646;
    font-family:Inter,system-ui,sans-serif;color:#e8ecef;pointer-events:none;transition:opacity .35s}
  #dc-side .row{display:flex;gap:14px;align-items:center;padding:14px 18px;border:1px solid #2a3138;border-radius:14px;margin-bottom:12px;background:#12161b;font-size:18px}
  #dc-side .row .s{margin-left:auto;font-weight:700;font-size:16px}
  #dc-side .on{border-color:#c8f26a}
  #dc-side .on .s{color:#c8f26a}
  #dc-side .off .s{color:#6b747c}
  #dc-side .bad{border-color:#ff6b6b}
  #dc-side .bad .s{color:#ff6b6b}
  #dc-side h4{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#8a949c;margin:0 0 14px}
  #dc-card{position:fixed;inset:0;z-index:2147483647;background:#0b0e12;display:flex;flex-direction:column;align-items:center;justify-content:center;
    font-family:Inter,system-ui,sans-serif;color:#e8ecef;text-align:center;transition:opacity .5s}
  #dc-card .t{font-size:72px;font-weight:800;letter-spacing:-.02em}
  #dc-card .t span{color:#c8f26a}
  #dc-card .b{font-size:26px;color:#b7c0c8;margin-top:18px;max-width:1100px;line-height:1.5}
  #dc-card .m{font-size:20px;color:#8a949c;margin-top:36px;font-family:ui-monospace,monospace}
  #dc-cur{position:fixed;width:26px;height:26px;border-radius:50%;background:rgba(200,242,106,.35);border:2px solid #c8f26a;
    z-index:2147483647;pointer-events:none;left:800px;top:450px;transform:translate(-50%,-50%);transition:left .6s ease,top .6s ease,transform .15s}
  #dc-cur.c{transform:translate(-50%,-50%) scale(.6)}\`;
  const boot = () => {
    if (document.getElementById('dc-style')) return;
    const s = document.createElement('style'); s.id = 'dc-style'; s.textContent = css; document.head.appendChild(s);
    for (const id of ['dc-cap', 'dc-side', 'dc-cur']) { const d = document.createElement('div'); d.id = id; document.body.appendChild(d); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.__dc = {
    cap(k, t, b) { const e = document.getElementById('dc-cap'); e.style.opacity = 0; setTimeout(() => { e.innerHTML = '<div class="k">' + k + '</div><div class="t">' + t + '</div><div class="b">' + b + '</div>'; e.style.opacity = 1; }, 300); },
    side(title, rows) { const e = document.getElementById('dc-side'); if (!rows) { e.style.opacity = 0; return; }
      e.innerHTML = '<h4>' + title + '</h4>' + rows.map(([n, st, cl]) => '<div class="row ' + cl + '"><span>' + n + '</span><span class="s">' + st + '</span></div>').join(''); e.style.opacity = 1; },
    card(t, b, m) { let e = document.getElementById('dc-card'); if (!t) { if (e) { e.style.opacity = 0; setTimeout(() => e.remove(), 500); } return; }
      if (!e) { e = document.createElement('div'); e.id = 'dc-card'; document.body.appendChild(e); }
      e.innerHTML = '<div class="t">' + t + '</div><div class="b">' + (b || '') + '</div><div class="m">' + (m || '') + '</div>'; e.style.opacity = 1; },
    move(x, y) { const c = document.getElementById('dc-cur'); c.style.left = x + 'px'; c.style.top = y + 'px'; },
    press(on) { document.getElementById('dc-cur').classList.toggle('c', on); },
  };
})();`;

(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const ctx = await b.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: 'video', size: { width: W, height: H } } });
  await ctx.addInitScript(OVERLAY);
  const p = await ctx.newPage();
  const wait = (ms) => p.waitForTimeout(ms);
  const cap = (k, t, body) => p.evaluate(([k, t, b]) => window.__dc.cap(k, t, b), [k, t, body]);
  const side = (title, rows) => p.evaluate(([t, r]) => window.__dc.side(t, r), [title, rows]);
  const card = (t, body, m) => p.evaluate(([t, b, m]) => window.__dc.card(t, b, m), [t, body, m]);
  async function click(loc, pause = 500) {
    await loc.scrollIntoViewIfNeeded();
    const bb = await loc.boundingBox();
    await p.evaluate(([x, y]) => window.__dc.move(x, y), [bb.x + bb.width / 2, bb.y + bb.height / 2]);
    await wait(750);
    await p.evaluate(() => window.__dc.press(true));
    await wait(150);
    await loc.click();
    await p.evaluate(() => window.__dc.press(false));
    await wait(pause);
  }
  const sheetOk = async (pause = 900) => { const btn = p.locator('.sheet-wrap .btn.primary').first(); await btn.waitFor({ state: 'visible', timeout: 15000 }); await wait(pause); await click(btn, 300); };
  async function type(sel, text) { await click(p.locator(sel), 200); await p.locator(sel).pressSequentially(text, { delay: 25 }); await wait(300); }
  const KEYS = (w, k, s, op) => side('Who signs', [['Your wallet', w[0], w[1]], ['Webapp key (passkey)', k[0], k[1]], ['Service key', s[0], s[1]], ['Service operator', op[0], op[1]]]);

  // 0. Cartão de abertura
  await p.goto('http://127.0.0.1:5173/');
  await wait(800);
  await card('Double <span>Check</span>', 'Solana custody where no single key can move your funds.<br>Squads v4 multisig, 2 of 3: your wallet + a passkey-protected device key + the service.', 'local demo · UI in Portuguese, captions in English');
  await wait(6000);
  await card(null);
  await cap('Sign-up', 'One account, three keys', 'Connect any Solana wallet (Phantom, Backpack, Solflare). In this local demo, <b>"Carteira de teste A"</b> plays the role of the wallet popup and <b>"Biometria de teste"</b> plays the fingerprint.');
  await wait(5500);

  // 1. Cadastro
  await click(p.getByRole('button', { name: 'Carteira de teste A' }));
  await cap('Sign-up · step 1', 'Your fingerprint creates the webapp key', 'A new Ed25519 key is generated on this device and encrypted with the passkey\'s <b>PRF</b> secret. The service only ever stores the ciphertext.');
  await sheetOk(3500);
  await cap('Sign-up · step 2', 'Your wallet creates the 2-of-3 account', 'The webapp checks the transaction first: only the Squads multisig creation, with the right members. Your wallet signs and pays about <b>0.003 SOL</b>, once.');
  await sheetOk(4000);
  await wait(1500);
  await cap('Home', 'Your Vault is a Squads v4 multisig', '<b>"Proteção 2 de 3"</b>: any move needs two votes. The service holds no SOL and pays nothing: fees come from your wallet.');
  await KEYS(['vote', 'on'], ['vote', 'on'], ['vote', 'on'], ['executes', 'on']);
  await wait(5000);
  await click(p.getByRole('button', { name: '10 SOL no Vault' }), 1500);
  await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await wait(1200);

  // 2. Envio
  await cap('Send', 'Sending 1.5 SOL', 'The service checks your policy (limits, destination) and simulates. Nothing touches the chain yet.');
  await KEYS(['waiting', 'off'], ['waiting', 'off'], ['does not vote on sends', 'off'], ['waiting', 'off']);
  await click(p.getByRole('button', { name: 'Enviar', exact: true }), 800);
  await type('#dest', DEST);
  await type('#amt', '1.5');
  await click(p.getByRole('button', { name: 'Revisar' }), 2500);
  await cap('Review', 'No blind signing', 'The webapp rebuilds the transaction <b>on its own</b> from what it shows you and compares it <b>byte by byte</b> with what the server sent. "Conferido" = verified: it does exactly this.');
  await wait(7000);
  await click(p.locator('.btn.primary', { hasText: /^Assinar$/ }));
  await cap('Send · vote 1', 'Fingerprint approves these exact bytes', 'The passkey unlocks the webapp key, which signs the approval. Then the service operator signs the execution, after the policy check.');
  await sheetOk(3500);
  await KEYS(['waiting', 'off'], ['voted', 'on'], ['does not vote on sends', 'off'], ['signed execute', 'on']);
  await cap('Send · vote 2', 'Your wallet signs once and pays', 'One atomic transaction: create, two approvals, execute, close. If anything fails, <b>nothing happens on Solana</b>. Fee: about 0.000015 SOL.');
  await sheetOk(3500);
  await KEYS(['voted + paid', 'on'], ['voted', 'on'], ['does not vote on sends', 'off'], ['executed', 'on']);
  await wait(1500);
  await cap('Done', 'Executed on Solana', 'The four real steps: fingerprint, policy + operator, your wallet, execution. A leaked seed phrase alone could never have done this.');
  await wait(6000);
  await side(null);
  await click(p.getByRole('button', { name: 'Voltar ao início' }), 1200);

  // 3. Servidor malicioso
  await cap('Attack 1', 'What if our server is hacked?', 'This test switch makes the server <b>lie</b>: it shows 1/10 of the real amount. Let\'s send 2 SOL.');
  await p.getByText('Simular servidor malicioso').scrollIntoViewIfNeeded();
  await click(p.getByText('Simular servidor malicioso'), 1500);
  await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await wait(800);
  await click(p.getByRole('button', { name: 'Enviar', exact: true }), 800);
  await type('#dest', DEST);
  await type('#amt', '2');
  await click(p.getByRole('button', { name: 'Revisar' }), 2500);
  await cap('Attack 1', 'Transaction blocked', '<b>"Transação bloqueada"</b>: the server showed 0.2 SOL, the transaction moves 2 SOL. The webapp caught the mismatch before any signature. Nothing was signed, no funds moved.');
  await wait(8000);
  await click(p.getByRole('button', { name: 'Entendi' }), 1000);
  const cb = p.getByLabel(/Simular servidor malicioso/);
  if (await cb.isVisible().catch(() => false) && await cb.isChecked()) await click(p.getByText('Simular servidor malicioso'), 600);
  await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await wait(800);

  // 4. Troca de chave + veto
  await cap('Attack 2', 'Someone tries to swap a key', 'Any key can be replaced with two votes (lost phone, lost wallet). Here a test button simulates a request to replace the <b>service key</b>, as an attacker would.');
  await p.getByRole('button', { name: 'Simular pedido de troca da chave do serviço' }).scrollIntoViewIfNeeded();
  await click(p.getByRole('button', { name: 'Simular pedido de troca da chave do serviço' }), 800);
  await sheetOk(2500);
  await wait(1500);
  await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await cap('Attack 2', '72-hour delay, and you get warned', '<b>"Troca de chave pendente"</b>: every key change waits 72 h (2 min in this local demo). An email alert goes out, and the key being replaced can veto.');
  await wait(7000);
  await click(p.getByRole('button', { name: /Não fui eu/ }), 800);
  await cap('Attack 2', '"Não fui eu" = "It wasn\'t me"', 'Your fingerprint signs the veto. Only the operator can execute, so the veto takes effect immediately, and the request can never run.');
  await sheetOk(3500);
  await wait(1500);
  await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await cap('Attack 2', 'Vetoed', 'The pending change is gone. Same protection when someone steals your wallet and tries to recover the device key: the current key says no.');
  await wait(6000);

  // 5. Cartão final
  await cap('', '', '');
  await card('Double <span>Check</span>', '76 tests run against the <b>mainnet Squads v4 program binary</b> (LiteSVM):<br>wallet alone or service alone: impossible · atomic sends · 72 h key changes with veto ·<br>a server that lies about a transaction is caught before you sign', 'github.com/sjoel99/double-check · live on devnet: dupla.sjoel99.com');
  await wait(7000);
  await ctx.close();
  await b.close();
})();

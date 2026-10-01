// Baixa da mainnet o binário do programa Squads v4 e a conta ProgramConfig,
// para os testes rodarem no LiteSVM com o mesmo código que roda na rede.
// Uso: pnpm fixtures   (RPC em SOLANA_MAINNET_RPC, padrão: RPC público)
import { Connection, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const rpc = process.env.SOLANA_MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";
const conn = new Connection(rpc, "confirmed");
const programId = multisig.PROGRAM_ID;

const program = await conn.getAccountInfo(programId);
if (!program) throw new Error("programa não encontrado");
const programDataAddr = new PublicKey(program.data.subarray(4, 36));
const programData = await conn.getAccountInfo(programDataAddr);
if (!programData) throw new Error("programdata não encontrado");
// UpgradeableLoaderState::ProgramData: 4 (tag) + 8 (slot) + 1 + 32 (authority) = 45 bytes
const elf = programData.data.subarray(45);
const slot = programData.data.readBigUInt64LE(4);

const [programConfigPda] = multisig.getProgramConfigPda({});
const programConfig = await conn.getAccountInfo(programConfigPda);
if (!programConfig) throw new Error("program config não encontrado");
const cfg = multisig.accounts.ProgramConfig.fromAccountInfo(programConfig)[0];

mkdirSync("fixtures", { recursive: true });
writeFileSync("fixtures/squads_multisig_program.so", elf);
writeFileSync(
  "fixtures/program_config.json",
  JSON.stringify(
    {
      address: programConfigPda.toBase58(),
      owner: programConfig.owner.toBase58(),
      lamports: programConfig.lamports,
      data: programConfig.data.toString("base64"),
      treasury: cfg.treasury.toBase58(),
      multisigCreationFee: cfg.multisigCreationFee.toString(),
    },
    null,
    2,
  ),
);
const sha = createHash("sha256").update(elf).digest("hex");
writeFileSync(
  "fixtures/ORIGEM.md",
  `# Origem das fixtures\n\n- programa: \`${programId.toBase58()}\`\n- programdata: \`${programDataAddr.toBase58()}\` (último deploy no slot ${slot})\n- sha256 do ELF (sem os 45 bytes de cabeçalho): \`${sha}\`\n- program config: \`${programConfigPda.toBase58()}\`, treasury \`${cfg.treasury.toBase58()}\`, taxa de criação ${cfg.multisigCreationFee} lamports\n- baixado em ${new Date().toISOString()} de ${rpc.replace(/api-key=.*/, "api-key=***")}\n`,
);
console.log({ bytes: elf.length, sha, slot, fee: cfg.multisigCreationFee.toString() });

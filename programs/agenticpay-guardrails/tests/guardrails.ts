import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Ed25519Program,
  Transaction,
} from "@solana/web3.js";
import { assert, expect } from "chai";
import * as nacl from "tweetnacl";

describe("agenticpay-guardrails", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = (anchor.workspace.AgenticpayGuardrails ||
    anchor.workspace.agenticpay_guardrails) as any;
  const owner = provider.wallet;

  const agentKeypair = Keypair.generate();
  const sessionKeypair = Keypair.generate();
  const providerKeypair = Keypair.generate();

  let escrowPda: PublicKey;
  let escrowBump: number;

  let sessionKeyPda: PublicKey;
  let sessionKeyBump: number;

  const DAILY_CAP = new anchor.BN(10_000_000); // 0.01 SOL
  const PER_TX_CAP = new anchor.BN(2_000_000);   // 0.002 SOL

  const DOMAIN_SEPARATOR = Buffer.from("agenticpay_x402v1");

  function createCanonicalMessage(
    nonce: anchor.BN,
    agent: PublicKey,
    providerPubkey: PublicKey,
    amountLamports: anchor.BN,
    expiresAt: anchor.BN
  ): Buffer {
    const buf = Buffer.alloc(105);
    let offset = 0;

    DOMAIN_SEPARATOR.copy(buf, offset);
    offset += 17;

    buf.writeBigUInt64LE(BigInt(nonce.toString()), offset);
    offset += 8;

    agent.toBuffer().copy(buf, offset);
    offset += 32;

    providerPubkey.toBuffer().copy(buf, offset);
    offset += 32;

    buf.writeBigUInt64LE(BigInt(amountLamports.toString()), offset);
    offset += 8;

    buf.writeBigInt64LE(BigInt(expiresAt.toString()), offset);
    return buf;
  }

  function getNonceReceiptPda(nonce: anchor.BN): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("nonce"),
        escrowPda.toBuffer(),
        nonce.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    return pda;
  }

  before(async () => {
    // Derive Escrow PDA: [b"escrow", owner.pubkey]
    [escrowPda, escrowBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), owner.publicKey.toBuffer()],
      program.programId
    );

    // Derive SessionKey PDA: [b"session", escrowPda, sessionKeypair.pubkey]
    [sessionKeyPda, sessionKeyBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        escrowPda.toBuffer(),
        sessionKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // Fund escrow PDA with SOL so it can pay out settled vouchers
    const airdropSig = await provider.connection.requestAirdrop(
      escrowPda,
      5 * anchor.web3.LAMPORTS_PER_SOL
    );
    // Fund agent keypair with SOL so it can pay for nonce receipt rent
    const airdropAgentSig = await provider.connection.requestAirdrop(
      agentKeypair.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    const latestBlockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      signature: airdropSig,
      ...latestBlockhash,
    });
    await provider.connection.confirmTransaction({
      signature: airdropAgentSig,
      ...latestBlockhash,
    });
  });

  it("Initializes escrow for an agent", async () => {
    await program.methods
      .initializeEscrow(DAILY_CAP, PER_TX_CAP)
      .accounts({
        escrow: escrowPda,
        owner: owner.publicKey,
        agent: agentKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const escrow = await program.account.escrow.fetch(escrowPda);
    assert.ok(escrow.owner.equals(owner.publicKey));
    assert.ok(escrow.agent.equals(agentKeypair.publicKey));
    assert.equal(escrow.dailyCapLamports.toString(), DAILY_CAP.toString());
    assert.equal(escrow.perTxCapLamports.toString(), PER_TX_CAP.toString());
    assert.equal(escrow.spentTodayLamports.toString(), "0");
    assert.isFalse(escrow.paused);
  });

  it("Toggles emergency pause by owner", async () => {
    await program.methods
      .setPaused(true)
      .accounts({
        escrow: escrowPda,
        owner: owner.publicKey,
      })
      .rpc();

    let escrow = await program.account.escrow.fetch(escrowPda);
    assert.isTrue(escrow.paused);

    await program.methods
      .setPaused(false)
      .accounts({
        escrow: escrowPda,
        owner: owner.publicKey,
      })
      .rpc();

    escrow = await program.account.escrow.fetch(escrowPda);
    assert.isFalse(escrow.paused);
  });

  it("Registers a session key", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new anchor.BN(now + 3600);
    const perTxLimit = new anchor.BN(1_000_000);

    await program.methods
      .registerSession(sessionKeypair.publicKey, perTxLimit, expiresAt)
      .accounts({
        escrow: escrowPda,
        session: sessionKeyPda,
        sessionKey: sessionKeypair.publicKey,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const session = await program.account.sessionKey.fetch(sessionKeyPda);
    assert.ok(session.escrow.equals(escrowPda));
    assert.ok(session.sessionKey.equals(sessionKeypair.publicKey));
    assert.equal(session.perTxLimit.toString(), perTxLimit.toString());
    assert.equal(session.expiresAt.toString(), expiresAt.toString());
  });

  it("Settles a valid voucher with Ed25519 signature verification", async () => {
    const nonce = new anchor.BN(1001);
    const amountLamports = new anchor.BN(500_000);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new anchor.BN(now + 300);

    const canonicalMessage = createCanonicalMessage(
      nonce,
      agentKeypair.publicKey,
      providerKeypair.publicKey,
      amountLamports,
      expiresAt
    );

    const signature = nacl.sign.detached(
      canonicalMessage,
      agentKeypair.secretKey
    );

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: agentKeypair.publicKey.toBytes(),
      message: canonicalMessage,
      signature: signature,
      instructionIndex: 0,
    });

    const settleIx = await program.methods
      .batchSettleVouchers(
        canonicalMessage,
        providerKeypair.publicKey,
        amountLamports,
        nonce,
        expiresAt
      )
      .accounts({
        escrow: escrowPda,
        nonceReceipt: getNonceReceiptPda(nonce),
        provider: providerKeypair.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        payer: agentKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const providerBalBefore = await provider.connection.getBalance(
      providerKeypair.publicKey
    );

    const tx = new Transaction().add(ed25519Ix).add(settleIx);
    await provider.sendAndConfirm(tx, [agentKeypair]);

    const providerBalAfter = await provider.connection.getBalance(
      providerKeypair.publicKey
    );
    assert.equal(
      providerBalAfter - providerBalBefore,
      amountLamports.toNumber()
    );

    const escrow = await program.account.escrow.fetch(escrowPda);
    assert.equal(escrow.spentTodayLamports.toString(), amountLamports.toString());
  });

  it("Rejects a replayed voucher (nonce already consumed)", async () => {
    const nonce = new anchor.BN(2001);
    const amount = new anchor.BN(300_000);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new anchor.BN(now + 300);

    const canonical = createCanonicalMessage(
      nonce,
      agentKeypair.publicKey,
      providerKeypair.publicKey,
      amount,
      expiresAt
    );
    const signature = nacl.sign.detached(canonical, agentKeypair.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: agentKeypair.publicKey.toBytes(),
      message: canonical,
      signature,
      instructionIndex: 0,
    });

    // Derive the nonce receipt PDA.
    const [nonceReceiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nonce"), escrowPda.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const settleIx = await program.methods
      .batchSettleVouchers(canonical, providerKeypair.publicKey, amount, nonce, expiresAt)
      .accounts({
        escrow: escrowPda,
        nonceReceipt: nonceReceiptPda,
        provider: providerKeypair.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        payer: agentKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // First submission: should succeed.
    const tx1 = new Transaction().add(ed25519Ix).add(settleIx);
    await provider.sendAndConfirm(tx1, [agentKeypair]);

    // Second submission with the exact same voucher: must fail.
    const tx2 = new Transaction().add(ed25519Ix).add(settleIx);
    try {
      await provider.sendAndConfirm(tx2, [agentKeypair]);
      assert.fail("Replay should have been rejected");
    } catch (err: any) {
      expect(err.toString()).to.include("NonceAlreadyUsed");
    }

    // Confirm the receipt exists on-chain for external observability.
    const receipt = await program.account.nonceReceipt.fetch(nonceReceiptPda);
    assert.equal(receipt.nonce.toString(), nonce.toString());
  });

  it("Rejects voucher exceeding per-tx cap", async () => {
    const nonce = new anchor.BN(1002);
    const excessiveAmount = new anchor.BN(3_000_000); // Exceeds PER_TX_CAP (2M)
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new anchor.BN(now + 300);

    const canonicalMessage = createCanonicalMessage(
      nonce,
      agentKeypair.publicKey,
      providerKeypair.publicKey,
      excessiveAmount,
      expiresAt
    );

    const signature = nacl.sign.detached(
      canonicalMessage,
      agentKeypair.secretKey
    );

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: agentKeypair.publicKey.toBytes(),
      message: canonicalMessage,
      signature: signature,
      instructionIndex: 0,
    });

    const settleIx = await program.methods
      .batchSettleVouchers(
        canonicalMessage,
        providerKeypair.publicKey,
        excessiveAmount,
        nonce,
        expiresAt
      )
      .accounts({
        escrow: escrowPda,
        nonceReceipt: getNonceReceiptPda(nonce),
        provider: providerKeypair.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        payer: agentKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(settleIx);
    try {
      await provider.sendAndConfirm(tx, [agentKeypair]);
      assert.fail("Should have failed with PerTxCapExceeded");
    } catch (err: any) {
      expect(err.toString()).to.include("PerTxCapExceeded");
    }
  });

  it("Rejects expired voucher", async () => {
    const nonce = new anchor.BN(1003);
    const amount = new anchor.BN(100_000);
    const expiredTime = new anchor.BN(Math.floor(Date.now() / 1000) - 60);

    const canonicalMessage = createCanonicalMessage(
      nonce,
      agentKeypair.publicKey,
      providerKeypair.publicKey,
      amount,
      expiredTime
    );

    const signature = nacl.sign.detached(
      canonicalMessage,
      agentKeypair.secretKey
    );

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: agentKeypair.publicKey.toBytes(),
      message: canonicalMessage,
      signature: signature,
      instructionIndex: 0,
    });

    const settleIx = await program.methods
      .batchSettleVouchers(
        canonicalMessage,
        providerKeypair.publicKey,
        amount,
        nonce,
        expiredTime
      )
      .accounts({
        escrow: escrowPda,
        nonceReceipt: getNonceReceiptPda(nonce),
        provider: providerKeypair.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        payer: agentKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(settleIx);
    try {
      await provider.sendAndConfirm(tx, [agentKeypair]);
      assert.fail("Should have failed with VoucherExpired");
    } catch (err: any) {
      expect(err.toString()).to.include("VoucherExpired");
    }
  });

  it("Rejects voucher when escrow is paused", async () => {
    // 1. Pause escrow
    await program.methods
      .setPaused(true)
      .accounts({
        escrow: escrowPda,
        owner: owner.publicKey,
      })
      .rpc();

    const nonce = new anchor.BN(1004);
    const amount = new anchor.BN(100_000);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new anchor.BN(now + 300);

    const canonicalMessage = createCanonicalMessage(
      nonce,
      agentKeypair.publicKey,
      providerKeypair.publicKey,
      amount,
      expiresAt
    );

    const signature = nacl.sign.detached(
      canonicalMessage,
      agentKeypair.secretKey
    );

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: agentKeypair.publicKey.toBytes(),
      message: canonicalMessage,
      signature: signature,
      instructionIndex: 0,
    });

    const settleIx = await program.methods
      .batchSettleVouchers(
        canonicalMessage,
        providerKeypair.publicKey,
        amount,
        nonce,
        expiresAt
      )
      .accounts({
        escrow: escrowPda,
        nonceReceipt: getNonceReceiptPda(nonce),
        provider: providerKeypair.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        payer: agentKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(settleIx);
    try {
      await provider.sendAndConfirm(tx, [agentKeypair]);
      assert.fail("Should have failed with Paused");
    } catch (err: any) {
      expect(err.toString()).to.include("Paused");
    } finally {
      // Unpause for remaining tests
      await program.methods
        .setPaused(false)
        .accounts({
          escrow: escrowPda,
          owner: owner.publicKey,
        })
        .rpc();
    }
  });

  it("Rejects tampered canonical message", async () => {
    const nonce = new anchor.BN(1005);
    const legitimateAmount = new anchor.BN(100_000);
    const tamperedAmount = new anchor.BN(200_000);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new anchor.BN(now + 300);

    // Message signed by agent:
    const signedMessage = createCanonicalMessage(
      nonce,
      agentKeypair.publicKey,
      providerKeypair.publicKey,
      legitimateAmount,
      expiresAt
    );

    // Tampered message submitted to program:
    const tamperedMessage = createCanonicalMessage(
      nonce,
      agentKeypair.publicKey,
      providerKeypair.publicKey,
      tamperedAmount,
      expiresAt
    );

    const signature = nacl.sign.detached(
      signedMessage,
      agentKeypair.secretKey
    );

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: agentKeypair.publicKey.toBytes(),
      message: signedMessage,
      signature: signature,
      instructionIndex: 0,
    });

    const settleIx = await program.methods
      .batchSettleVouchers(
        tamperedMessage,
        providerKeypair.publicKey,
        tamperedAmount,
        nonce,
        expiresAt
      )
      .accounts({
        escrow: escrowPda,
        nonceReceipt: getNonceReceiptPda(nonce),
        provider: providerKeypair.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        payer: agentKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(settleIx);
    try {
      await provider.sendAndConfirm(tx, [agentKeypair]);
      assert.fail("Should have failed with MessageMismatch");
    } catch (err: any) {
      expect(err.toString()).to.include("MessageMismatch");
    }
  });

  it("Rejects signature from unauthorized agent keypair", async () => {
    const rogueKeypair = Keypair.generate();
    const nonce = new anchor.BN(1006);
    const amount = new anchor.BN(100_000);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new anchor.BN(now + 300);

    const canonicalMessage = createCanonicalMessage(
      nonce,
      rogueKeypair.publicKey,
      providerKeypair.publicKey,
      amount,
      expiresAt
    );

    const signature = nacl.sign.detached(
      canonicalMessage,
      rogueKeypair.secretKey
    );

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: rogueKeypair.publicKey.toBytes(),
      message: canonicalMessage,
      signature: signature,
      instructionIndex: 0,
    });

    const settleIx = await program.methods
      .batchSettleVouchers(
        canonicalMessage,
        providerKeypair.publicKey,
        amount,
        nonce,
        expiresAt
      )
      .accounts({
        escrow: escrowPda,
        nonceReceipt: getNonceReceiptPda(nonce),
        provider: providerKeypair.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        payer: agentKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(settleIx);
    try {
      await provider.sendAndConfirm(tx, [agentKeypair]);
      assert.fail("Should have failed with AgentPubkeyMismatch");
    } catch (err: any) {
      expect(err.toString()).to.include("AgentPubkeyMismatch");
    }
  });

  it("Rejects voucher when cumulative spend exceeds daily cap", async () => {
    const escrow = await program.account.escrow.fetch(escrowPda);
    const spentToday = BigInt(escrow.spentTodayLamports.toString());
    const dailyCap = BigInt(escrow.dailyCapLamports.toString());
    const remaining = dailyCap - spentToday;

    // First settle up to remaining budget in increments of PER_TX_CAP
    const perTxCap = 2_000_000n;
    let currentRemaining = remaining;
    let subNonce = 3000;

    while (currentRemaining > perTxCap) {
      const payAmount = new anchor.BN(perTxCap.toString());
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = new anchor.BN(now + 300);
      const n = new anchor.BN(subNonce++);

      const msg = createCanonicalMessage(
        n,
        agentKeypair.publicKey,
        providerKeypair.publicKey,
        payAmount,
        expiresAt
      );
      const sig = nacl.sign.detached(msg, agentKeypair.secretKey);
      const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: agentKeypair.publicKey.toBytes(),
        message: msg,
        signature: sig,
        instructionIndex: 0,
      });
      const settleIx = await program.methods
        .batchSettleVouchers(
          msg,
          providerKeypair.publicKey,
          payAmount,
          n,
          expiresAt
        )
        .accounts({
          escrow: escrowPda,
          nonceReceipt: getNonceReceiptPda(n),
          provider: providerKeypair.publicKey,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          payer: agentKeypair.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      await provider.sendAndConfirm(new Transaction().add(ed25519Ix).add(settleIx), [agentKeypair]);
      currentRemaining -= perTxCap;
    }

    // Now currentRemaining <= perTxCap.
    // Try to settle an amount > currentRemaining (e.g. currentRemaining + 1)
    const exceedAmount = new anchor.BN((currentRemaining + 100_000n).toString());
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new anchor.BN(now + 300);
    const finalNonce = new anchor.BN(9999);

    const msg = createCanonicalMessage(
      finalNonce,
      agentKeypair.publicKey,
      providerKeypair.publicKey,
      exceedAmount,
      expiresAt
    );
    const sig = nacl.sign.detached(msg, agentKeypair.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: agentKeypair.publicKey.toBytes(),
      message: msg,
      signature: sig,
      instructionIndex: 0,
    });
    const settleIx = await program.methods
      .batchSettleVouchers(
        msg,
        providerKeypair.publicKey,
        exceedAmount,
        finalNonce,
        expiresAt
      )
      .accounts({
        escrow: escrowPda,
        nonceReceipt: getNonceReceiptPda(finalNonce),
        provider: providerKeypair.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        payer: agentKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    try {
      await provider.sendAndConfirm(new Transaction().add(ed25519Ix).add(settleIx), [agentKeypair]);
      assert.fail("Should have failed with DailyCapExceeded");
    } catch (err: any) {
      expect(err.toString()).to.include("DailyCapExceeded");
    }
  });
});
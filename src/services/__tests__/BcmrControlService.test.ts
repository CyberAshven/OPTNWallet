import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  binToHex,
  encodeCashAddress,
  encodeTransaction,
  hexToBin,
} from '@bitauth/libauth';
import type { UTXO } from '../../types/types';
import { generateBcmrRegistry } from '../../pages/apps/mint-cashtokens-poc/services/bcmrRegistryGenerator';
import { buildBcmrPublicationOpReturn } from '../../pages/apps/mint-cashtokens-poc/services/bcmrOpReturn';

const state = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  failWrite: false,
  switchOnWrite: false,
  walletId: 7,
  network: 'chipnet',
  signing: vi.fn(),
  broadcast: vi.fn(),
}));
vi.mock('localforage', () => ({
  default: {
    createInstance: () => ({
      iterate: async (callback: (value: unknown, key: string) => void) => {
        for (const [key, value] of state.data)
          callback(structuredClone(value), key);
      },
      setItem: async (key: string, value: unknown) => {
        if (state.failWrite) throw new Error('storage full');
        state.data.set(key, structuredClone(value));
        if (state.switchOnWrite) state.walletId = 8;
        return value;
      },
      getItem: async (key: string) =>
        structuredClone(state.data.get(key) ?? null),
    }),
  },
}));
vi.mock('../../state/store', () => ({
  store: {
    getState: () => ({
      wallet_id: {
        currentWalletId: state.walletId,
        networkType: state.network,
        sessionGeneration: 1,
      },
      network: { currentNetwork: state.network },
    }),
  },
}));
vi.mock('../KeyService', () => ({
  default: {
    retrieveKeys: async () => [
      {
        address: encodeCashAddress({
          prefix: 'bchtest',
          type: 'p2pkh',
          payload: new Uint8Array(20).fill(11),
        }).address,
      },
    ],
    fetchAddressPrivateKey: state.signing,
  },
}));
vi.mock('../../apis/ContractManager/ContractManager', () => ({
  default: () => ({}),
}));
vi.mock('cashscript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('cashscript')>()),
  ElectrumNetworkProvider: class {
    sendRawTransaction = state.broadcast;
  },
}));

const category = Array.from({ length: 32 }, (_, n) =>
  n.toString(16).padStart(2, '0')
).join('');
const script = `76a914${'0b'.repeat(20)}88ac`;
const address = encodeCashAddress({
  prefix: 'bchtest',
  type: 'p2pkh',
  payload: new Uint8Array(20).fill(11),
}).address;
const coin = (hash: string, index = 0): UTXO =>
  ({ tx_hash: hash, tx_pos: index, value: 1000, address, height: 1 }) as UTXO;
function raw(parent: string, token = false, publication?: string): string {
  return binToHex(
    encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [
        {
          outpointTransactionHash: hexToBin(parent),
          outpointIndex: 0,
          sequenceNumber: 0xffffffff,
          unlockingBytecode: new Uint8Array(),
        },
      ],
      outputs: [
        { valueSatoshis: 1000n, lockingBytecode: hexToBin(script) },
        ...(token
          ? [
              {
                valueSatoshis: 1000n,
                lockingBytecode: hexToBin(script),
                token: { category: hexToBin(category), amount: 100n },
              },
            ]
          : []),
        ...(publication
          ? [{ valueSatoshis: 0n, lockingBytecode: hexToBin(publication) }]
          : []),
      ],
    })
  );
}
const request = () => ({
  walletId: 7,
  network: 'chipnet',
  address,
  transactionHex: raw(category, true),
  genesisCategories: [category],
});

describe('persisted BCMR custody through the real Rust WASM boundary', () => {
  beforeEach(() => {
    state.data.clear();
    state.failWrite = false;
    state.switchOnWrite = false;
    state.walletId = 7;
    state.network = 'chipnet';
    state.signing.mockClear();
    state.broadcast.mockClear();
  });

  it('mints without publication, reopens, publishes later, and protects both generations', async () => {
    let service = await import('../BcmrControlService');
    const minted = await service.approveBcmrControl(request());
    const txid = service.controlView(minted).txid;
    vi.resetModules(); // persistence survives module/runtime reconstruction
    service = await import('../BcmrControlService');
    expect(await service.listBcmrControls(7, 'chipnet')).toEqual([minted]);
    expect(
      await service.filterMetadataControls(7, [coin(txid), coin(txid, 1)])
    ).toEqual([coin(txid, 1)]);
    await expect(service.checkBcmrBroadcast(raw(txid))).rejects.toBeTruthy();
    await expect(
      service.checkBcmrBuild(
        [coin(txid)],
        [{ recipientAddress: address, amount: 700n }]
      )
    ).rejects.toThrow('metadata');
    const { gatherInputs } = await import(
      '../../platform/desktop/FusionService'
    );
    state.network = 'mainnet'; // an existing background round keeps its own network
    await expect(gatherInputs(7, [coin(txid)], 'chipnet')).rejects.toThrow(
      'metadata'
    );
    state.network = 'chipnet';
    const { default: TransactionBuilderHelper } = await import(
      '../../apis/TransactionManager/TransactionBuilderHelper'
    );
    const helper = TransactionBuilderHelper();
    await expect(
      helper.buildTransaction(
        [coin(txid)],
        [{ recipientAddress: address, amount: 700n }]
      )
    ).rejects.toThrow('metadata');
    await expect(helper.sendTransaction(raw(txid))).rejects.toBeTruthy();
    expect(state.broadcast).not.toHaveBeenCalled();
    expect(state.signing).not.toHaveBeenCalled();
    const registryJson = generateBcmrRegistry({
      network: 'chipnet',
      authbase: category,
      tokenCategory: category,
      tokenName: 'Deferred collection',
      tokenSymbol: 'LATER',
      tokenDecimals: 0,
      latestRevision: '2026-09-26T00:00:00.000Z',
    }).registryJson;
    const pub = buildBcmrPublicationOpReturn({
      registryJson,
      uris: ['ipfs://example'],
    });
    const outputs = [
      { recipientAddress: address, amount: 1000n },
      { opReturn: pub.opReturn },
    ];
    await expect(
      service.checkBcmrBuild([coin(txid)], outputs, {
        registryJson,
        uris: ['ipfs://example'],
        address,
      })
    ).resolves.toBeUndefined();
    await expect(
      service.checkBcmrBuild(
        [
          coin(txid),
          { ...coin('ff'.repeat(32), 1), token: { category, amount: 1 } },
        ],
        outputs,
        { registryJson, uris: ['ipfs://example'], address }
      )
    ).rejects.toThrow('no token transfers');
    const successor = await service.approveBcmrControl({
      walletId: 7,
      network: 'chipnet',
      address,
      transactionHex: raw(txid, false, pub.scriptHex),
      genesisCategories: [],
      registryJson,
    });
    await expect(
      service.checkBcmrBroadcast(successor.transactionHex)
    ).resolves.toBeUndefined();
    await expect(
      service.checkBcmrBroadcast(raw(service.controlView(successor).txid))
    ).rejects.toBeTruthy();
    await expect(service.checkBcmrBroadcast(raw(txid))).rejects.toBeTruthy();
  });

  it('fails closed for storage failure, corruption, and a changed wallet', async () => {
    const service = await import('../BcmrControlService');
    state.failWrite = true;
    await expect(service.approveBcmrControl(request())).rejects.toThrow(
      'storage full'
    );
    expect(state.data.size).toBe(0);
    state.failWrite = false;
    state.walletId = 8;
    await expect(service.approveBcmrControl(request())).rejects.toThrow(
      'Wallet changed'
    );
    state.walletId = 7;
    await expect(
      service.approveBcmrControl({ ...request(), sessionGeneration: 0 })
    ).rejects.toThrow('Wallet changed');
    state.switchOnWrite = true;
    await expect(service.approveBcmrControl(request())).rejects.toThrow(
      'Wallet changed'
    );
    // Keep the intent in its original scope, but do not allow the old callback to send.
    expect(await service.listBcmrControls(7, 'chipnet')).toHaveLength(1);
    state.switchOnWrite = false;
    state.walletId = 7;
    state.data.set('chipnet:7:bad', {
      transactionHex: '00',
      categories: [category],
    });
    await expect(
      service.checkBcmrBroadcast(raw(category))
    ).rejects.toBeTruthy();
  });

  it('keeps wallet and network records separate and never authorizes a modified raw transaction', async () => {
    const service = await import('../BcmrControlService');
    const minted = await service.approveBcmrControl(request());
    expect(await service.listBcmrControls(8, 'chipnet')).toEqual([]);
    expect(await service.listBcmrControls(7, 'mainnet')).toEqual([]);
    const txid = service.controlView(minted).txid;
    await expect(service.checkBcmrBroadcast(raw(txid))).rejects.toBeTruthy();
  });
});

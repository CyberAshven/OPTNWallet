// Durable public intent records; Rust owns transaction/control validation.
// Append each approved transaction independently, so concurrent windows cannot
// overwrite another identity and ambiguous broadcasts/reorgs retain protection.
import localForage from 'localforage';
import {
  binToHex,
  cashAddressToLockingBytecode,
  encodeTransaction,
  hexToBin,
  importMetadataRegistry,
} from '@bitauth/libauth';
import {
  bcmrApproveControl,
  bcmrCheckSpend,
  bcmrControlView,
  bcmrValidateControlRegistry,
  ensureOptnCore,
} from '../wasm/optn-core';
import { store } from '../state/store';
import { selectCurrentNetwork } from '../state/selectors/networkSelectors';
import type { TransactionOutput, UTXO } from '../types/types';
import { buildBcmrPublicationOpReturn } from '../pages/apps/mint-cashtokens-poc/services/bcmrOpReturn';

export type BcmrControl = { transactionHex: string; categories: string[] };
export type BcmrControlView = {
  txid: string;
  categories: string[];
  scriptHex: string;
  spentOutpoints: string[];
};
export type BcmrUpdate = {
  registryJson: string;
  uris: string[];
  address: string;
};
const records = localForage.createInstance({
  name: 'optn-bcmr-control',
  storeName: 'controls',
});

function prefix(walletId: number, network: string): string {
  if (
    !Number.isSafeInteger(walletId) ||
    walletId <= 0 ||
    !['mainnet', 'chipnet'].includes(network)
  ) {
    throw new Error('A wallet and network are required for metadata control.');
  }
  return `${network}:${walletId}:`;
}

export function controlView(record: BcmrControl): BcmrControlView {
  ensureOptnCore();
  return JSON.parse(bcmrControlView(JSON.stringify(record))) as BcmrControlView;
}

export async function listBcmrControls(
  walletId: number,
  network: string
): Promise<BcmrControl[]> {
  const keyPrefix = prefix(walletId, network);
  const result: BcmrControl[] = [];
  await records.iterate<BcmrControl, void>((value, key) => {
    if (!key.startsWith(keyPrefix)) return;
    const view = controlView(value);
    if (key !== `${keyPrefix}${view.txid}`)
      throw new Error('Invalid saved metadata control.');
    result.push(value);
  });
  return result;
}

function activeScope(walletId?: number) {
  const state = store.getState();
  const id = walletId ?? state.wallet_id?.currentWalletId;
  if (!id || id <= 0) return null;
  return { walletId: id, network: selectCurrentNetwork(state) };
}

export async function filterMetadataControls(
  walletId: number,
  coins: UTXO[],
  network?: string
): Promise<UTXO[]> {
  const scope = network ? { walletId, network } : activeScope(walletId);
  if (!scope) return coins;
  const controls = await listBcmrControls(scope.walletId, scope.network);
  const protectedKeys = new Set(
    controls.map((record) => `${controlView(record).txid}:0`)
  );
  return coins.filter(
    (coin) => !protectedKeys.has(`${coin.tx_hash.toLowerCase()}:${coin.tx_pos}`)
  );
}

export async function assertMetadataInputsAvailable(
  walletId: number,
  coins: UTXO[],
  network?: string
): Promise<void> {
  if (
    (await filterMetadataControls(walletId, coins, network)).length !==
    coins.length
  ) {
    throw new Error(
      'This coin controls token metadata. Use Add/update metadata instead of ordinary spending or CashFusion.'
    );
  }
}

export async function checkBcmrBroadcast(
  raw: string,
  walletId?: number
): Promise<void> {
  const scope = activeScope(walletId);
  if (!scope) return;
  const controls = await listBcmrControls(scope.walletId, scope.network);
  if (!controls.length) return;
  ensureOptnCore();
  bcmrCheckSpend(hexToBin(raw), JSON.stringify(controls));
}

async function ownedScript(
  walletId: number,
  network: string,
  address: string
): Promise<string> {
  const expectedPrefix = network === 'mainnet' ? 'bitcoincash:' : 'bchtest:';
  const { default: KeyService } = await import('./KeyService');
  const keys = await KeyService.retrieveKeys(walletId);
  if (
    !address.startsWith(expectedPrefix) ||
    !keys.some((key) => key.address === address)
  ) {
    throw new Error(
      'Metadata control must return to an address in this wallet and network.'
    );
  }
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  return binToHex(decoded.bytecode);
}

export function validateControlRegistry(
  json: string,
  categories: string[],
  network: string
): void {
  const parsed = importMetadataRegistry(json);
  if (typeof parsed === 'string') throw new Error(parsed);
  ensureOptnCore();
  bcmrValidateControlRegistry(json, JSON.stringify(categories), network);
}

export function assertMetadataSession(
  walletId: number,
  network: string,
  generation: number
): void {
  const state = store.getState();
  if (
    state.wallet_id.currentWalletId !== walletId ||
    state.wallet_id.sessionGeneration !== generation ||
    selectCurrentNetwork(state) !== network
  )
    throw new Error('Wallet changed; review again.');
}

export async function approveBcmrControl(
  options: {
    walletId: number;
    network: string;
    transactionHex: string;
    address: string;
    genesisCategories: string[];
    registryJson?: string;
    allowSharedControl?: boolean;
    sessionGeneration?: number;
  },
  persist = true
): Promise<BcmrControl> {
  const { walletId, network } = options;
  const generation =
    options.sessionGeneration ?? store.getState().wallet_id.sessionGeneration;
  const assertCurrent = () =>
    assertMetadataSession(walletId, network, generation);
  assertCurrent();
  if (
    options.registryJson !== undefined &&
    typeof importMetadataRegistry(options.registryJson) === 'string'
  )
    throw new Error('Invalid metadata registry.');
  const previous = await listBcmrControls(walletId, network);
  const script = await ownedScript(walletId, network, options.address);
  ensureOptnCore();
  const record = JSON.parse(
    bcmrApproveControl(
      JSON.stringify({
        network,
        transactionHex: options.transactionHex,
        ownedScriptHex: script,
        genesisCategories: options.genesisCategories,
        previous,
        registryJson: options.registryJson ?? null,
        allowSharedControl: options.allowSharedControl ?? false,
      })
    )
  ) as BcmrControl;
  assertCurrent();
  if (persist) {
    const key = `${prefix(walletId, network)}${controlView(record).txid}`;
    await records.setItem(key, record);
    const saved = await records.getItem<BcmrControl>(key);
    if (JSON.stringify(saved) !== JSON.stringify(record))
      throw new Error(
        'Could not save metadata control; transaction was not sent.'
      );
  }
  assertCurrent();
  return record;
}

/** Runs BEFORE private keys are requested, including manually selected inputs. */
export async function checkBcmrBuild(
  inputs: UTXO[],
  outputs: TransactionOutput[],
  update?: BcmrUpdate
): Promise<void> {
  const scope = activeScope();
  if (!scope) return;
  if (!update) return assertMetadataInputsAvailable(scope.walletId, inputs);
  const publication = buildBcmrPublicationOpReturn(update);
  const publicationOutputs = outputs.filter(
    (output) => output.opReturn !== undefined
  );
  if (
    publicationOutputs.length !== 1 ||
    JSON.stringify(publicationOutputs[0].opReturn) !==
      JSON.stringify(publication.opReturn) ||
    outputs.some((o) => o.token) ||
    inputs.some((input) => input.token)
  ) {
    throw new Error(
      'Metadata update must contain exactly the reviewed publication and no token transfers.'
    );
  }
  const unsigned = binToHex(
    encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: inputs.map((input) => ({
        outpointTransactionHash: hexToBin(input.tx_hash),
        outpointIndex: input.tx_pos,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: new Uint8Array(),
      })),
      outputs: outputs.map((output) => {
        if (output.opReturn !== undefined)
          return {
            valueSatoshis: 0n,
            lockingBytecode: hexToBin(publication.scriptHex),
          };
        const decoded = cashAddressToLockingBytecode(
          output.recipientAddress ?? ''
        );
        if (typeof decoded === 'string') throw new Error(decoded);
        return {
          valueSatoshis: BigInt(output.amount ?? 0),
          lockingBytecode: decoded.bytecode,
        };
      }),
    })
  );
  await approveBcmrControl(
    {
      ...scope,
      transactionHex: unsigned,
      address: update.address,
      genesisCategories: [],
      registryJson: update.registryJson,
    },
    false
  );
}

import { useEffect, useRef, useState } from 'react';
import {
  approveBcmrControl,
  assertMetadataSession,
  controlView,
  listBcmrControls,
  validateControlRegistry,
  type BcmrControlView,
} from '../../../../services/BcmrControlService';
import { store } from '../../../../state/store';
import UTXOService from '../../../../services/UTXOService';
import TransactionService from '../../../../services/TransactionService';
import {
  uploadToIpfsRelay,
  waitForIpfsAvailability,
} from '../../../../services/IpfsService';
import { sha256 } from '../../../../utils/hash';
import type { UTXO } from '../../../../types/types';
import { buildBcmrPublicationOpReturn } from '../services/bcmrOpReturn';
import { selectFeeCandidates } from '../services/selectFeeCandidates';
import TxSummary from '../../../../components/confirm/TxSummary';
import { asTxSummaryInputs, asTxSummaryOutputs } from '../utils';

type Preview = {
  raw: string;
  inputs: UTXO[];
  outputs: NonNullable<
    Awaited<
      ReturnType<typeof TransactionService.buildTransaction>
    >['finalOutputs']
  >;
  bytes: number;
  fee: bigint;
  sessionGeneration: number;
};

/** Publication is a separate action: it never mints another token or changes commitments. */
export default function MetadataControls({
  walletId,
  network,
  address,
  revision,
}: {
  walletId: number;
  network: string;
  address: string;
  revision: string;
}) {
  const [controls, setControls] = useState<BcmrControlView[]>([]);
  const [selected, setSelected] = useState('');
  const [registry, setRegistry] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [refresh, setRefresh] = useState(0);
  const running = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setControls([]);
    setSelected('');
    setRegistry('');
    setPreview(null);
    if (walletId > 0)
      void listBcmrControls(walletId, network)
        .then((records) => {
          if (!cancelled) setControls(records.map(controlView));
        })
        .catch((error: unknown) => {
          if (!cancelled) setMessage(String(error));
        });
    return () => {
      cancelled = true;
    };
  }, [walletId, network, revision, refresh]);

  async function prepare() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage('Validating metadata…');
    setPreview(null);
    try {
      const sessionGeneration = store.getState().wallet_id.sessionGeneration;
      assertMetadataSession(walletId, network, sessionGeneration);
      const control = controls.find((entry) => entry.txid === selected);
      if (!control) throw new Error('Select the metadata control to update.');
      const { allUtxos } = await UTXOService.fetchAllWalletUtxos(walletId, {
        includeMetadataControls: true,
      });
      const identity = allUtxos.find(
        (coin) =>
          coin.tx_hash.toLowerCase() === control.txid && coin.tx_pos === 0
      );
      if (!identity)
        throw new Error(
          'This control output is not available. Sync the wallet and select its latest unspent successor.'
        );
      if (registry.length > 1_000_000)
        throw new Error('Registry is too large.');
      // Validate category binding before contacting an upload service.
      validateControlRegistry(registry, control.categories, network);
      assertMetadataSession(walletId, network, sessionGeneration);
      setMessage('Uploading and verifying registry…');
      const uploaded = await uploadToIpfsRelay(
        new Blob([registry], { type: 'application/json' }),
        { filename: 'bitcoin-cash-metadata-registry.json', rawCid: true }
      );
      const uri = `ipfs://${uploaded.cid}`;
      await waitForIpfsAvailability(uri, {
        timeoutMs: 45_000,
        pollIntervalMs: 1_500,
        validateResponse: async (response) => {
          if (sha256.text(await response.text()) !== sha256.text(registry))
            throw new Error('Uploaded registry bytes do not match.');
        },
      });
      const publication = buildBcmrPublicationOpReturn({
        registryJson: registry,
        uris: [uri],
      });
      const inputs = [identity];
      const fees = selectFeeCandidates(
        allUtxos,
        new Set([`${identity.tx_hash}:0`])
      );
      for (const fee of fees) {
        assertMetadataSession(walletId, network, sessionGeneration);
        inputs.push(fee);
        const built = await TransactionService.buildTransaction(
          [
            { recipientAddress: address, amount: 1000n },
            { opReturn: publication.opReturn },
          ],
          null,
          address,
          inputs,
          false,
          { registryJson: registry, uris: [uri], address }
        );
        if (built.errorMsg || !built.finalOutputs || !built.finalTransaction)
          continue;
        await approveBcmrControl(
          {
            walletId,
            network,
            sessionGeneration,
            address,
            transactionHex: built.finalTransaction,
            genesisCategories: [],
            registryJson: registry,
          },
          false
        );
        const feePaid =
          inputs.reduce(
            (sum, coin) => sum + BigInt(coin.value ?? coin.amount ?? 0),
            0n
          ) -
          built.finalOutputs.reduce(
            (sum, output) => sum + BigInt(output.amount ?? 0),
            0n
          );
        setPreview({
          raw: built.finalTransaction,
          inputs: [...inputs],
          outputs: built.finalOutputs,
          bytes: built.bytecodeSize,
          fee: feePaid,
          sessionGeneration,
        });
        setMessage(
          'Review the publication. Metadata control stays in this wallet.'
        );
        return;
      }
      throw new Error(
        'Could not build the publication. Keep a separate spendable BCH coin for its fee.'
      );
    } catch (error) {
      setMessage(String(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function publish() {
    if (!preview || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await approveBcmrControl({
        walletId,
        network,
        sessionGeneration: preview.sessionGeneration,
        address,
        transactionHex: preview.raw,
        genesisCategories: [],
        registryJson: registry,
      });
      const result = await TransactionService.sendTransaction(
        preview.raw,
        preview.inputs,
        { walletId }
      );
      if (!result.txid)
        throw new Error(result.errorMessage ?? 'Publication failed.');
      setMessage(
        `Publication ${result.broadcastState === 'submitted' ? 'submitted; confirmation pending' : 'broadcast'}: ${result.txid}`
      );
      setPreview(null);
      setRefresh((n) => n + 1);
    } catch (error) {
      setMessage(String(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <details className="wallet-card rounded-2xl p-4 space-y-3">
      <summary className="cursor-pointer font-semibold">
        Add/update metadata
      </summary>
      <p className="text-sm wallet-muted">
        Publish metadata after minting, or update a registry. This uses the
        saved metadata control, not your minting NFT. Saved attempts remain
        listed if a broadcast fails; only an unspent control can be used. These
        records are saved on this device; restoring a seed alone does not
        restore this list.
      </p>
      {controls.length ? (
        <>
          <label className="block">
            Metadata control
            <select
              className="wallet-input w-full"
              disabled={busy}
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">Choose a control</option>
              {controls.map((control) => (
                <option key={control.txid} value={control.txid}>
                  {control.categories.map((id) => id.slice(0, 12)).join(', ')} ·{' '}
                  {control.txid.slice(0, 10)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Registry file
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 1_000_000) {
                  setMessage('Registry is too large.');
                  return;
                }
                void file
                  .text()
                  .then((text) => {
                    setRegistry(text);
                    setPreview(null);
                  })
                  .catch((error) => setMessage(String(error)));
              }}
            />
          </label>
          <label className="block">
            Registry JSON
            <textarea
              className="wallet-input w-full"
              rows={6}
              disabled={busy}
              value={registry}
              onChange={(e) => {
                setRegistry(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <p className="text-sm wallet-muted">
            Include every category sharing this control. Keep existing NFT
            definitions and history when updating.
          </p>
          <button
            type="button"
            className="wallet-btn-primary px-3 py-2"
            disabled={busy || !selected || !registry}
            onClick={() => void prepare()}
          >
            Review publication
          </button>
        </>
      ) : (
        <p className="text-sm wallet-muted">
          Metadata controls from new mints will appear here.
        </p>
      )}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {preview ? (
        <section aria-label="Review metadata publication" className="space-y-3">
          <h3 className="font-semibold">Publish token metadata</h3>
          <p>Review the fee and retained control output before broadcasting.</p>
          <TxSummary
            inputs={asTxSummaryInputs(preview.inputs)}
            outputs={asTxSummaryOutputs(preview.outputs)}
            bytes={preview.bytes}
            fee={preview.fee}
          />
          <button
            type="button"
            className="wallet-btn-primary px-3 py-2"
            disabled={busy}
            onClick={() => void publish()}
          >
            Confirm publication
          </button>
          <button
            type="button"
            className="wallet-btn-secondary px-3 py-2"
            disabled={busy}
            onClick={() => setPreview(null)}
          >
            Cancel
          </button>
        </section>
      ) : null}
    </details>
  );
}

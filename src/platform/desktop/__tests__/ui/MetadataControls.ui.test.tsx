/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import MetadataControls from '../../../../pages/apps/mint-cashtokens-poc/components/MetadataControls';

const state = vi.hoisted(() => ({
  hash: 'ab'.repeat(32),
  events: [] as string[],
  failSave: true,
  approve: vi.fn(),
  send: vi.fn(),
  upload: vi.fn(),
  validate: vi.fn(),
  build: vi.fn(),
}));
vi.mock('../../../../services/BcmrControlService', () => ({
  listBcmrControls: async () => [
    { txid: state.hash, categories: ['cd'.repeat(32)] },
  ],
  controlView: (record: unknown) => record,
  assertMetadataSession: vi.fn(),
  validateControlRegistry: state.validate,
  approveBcmrControl: state.approve,
}));
vi.mock('../../../../state/store', () => ({
  store: { getState: () => ({ wallet_id: { sessionGeneration: 3 } }) },
}));
vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
vi.mock('../../../../services/UTXOService', () => ({
  default: {
    fetchAllWalletUtxos: async () => ({
      allUtxos: [
        { tx_hash: state.hash, tx_pos: 0, value: 1000 },
        { tx_hash: 'ef'.repeat(32), tx_pos: 1, value: 2000 },
      ],
    }),
  },
}));
vi.mock('../../../../services/TransactionService', () => ({
  default: { buildTransaction: state.build, sendTransaction: state.send },
}));
vi.mock('../../../../services/IpfsService', () => ({
  uploadToIpfsRelay: state.upload,
  waitForIpfsAvailability: async (
    _uri: string,
    options: {
      validateResponse: (response: {
        text: () => Promise<string>;
      }) => Promise<void>;
    }
  ) => {
    await options.validateResponse({ text: async () => '{}' });
  },
}));
afterEach(cleanup);

it('requires review and durable custody before sending; a failed save can be retried without losing the control', async () => {
  const user = userEvent.setup();
  state.events = [];
  state.failSave = true;
  state.approve.mockImplementation(
    async (_request: unknown, persist = true) => {
      if (persist) {
        if (state.failSave) throw new Error('storage full');
        state.events.push('saved');
      }
    }
  );
  state.upload.mockResolvedValue({ cid: 'example' });
  state.build.mockResolvedValue({
    finalTransaction: '0102',
    finalOutputs: [{ recipientAddress: 'wallet', amount: 2800n }],
    bytecodeSize: 200,
    errorMsg: '',
  });
  state.send.mockImplementation(async () => {
    state.events.push('sent');
    return { txid: 'sent-tx', broadcastState: 'submitted' };
  });
  render(
    <MetadataControls
      walletId={7}
      network="chipnet"
      address="wallet"
      revision=""
    />
  );
  await user.click(screen.getByText('Add/update metadata'));
  const select = await screen.findByLabelText('Metadata control');
  await user.selectOptions(select, state.hash);
  fireEvent.change(screen.getByLabelText('Registry JSON'), {
    target: { value: '{}' },
  });
  expect(state.upload).not.toHaveBeenCalled();
  expect(state.send).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Review publication' }));
  await screen.findByRole('region', { name: 'Review metadata publication' });
  expect(state.validate).toHaveBeenCalledWith(
    '{}',
    ['cd'.repeat(32)],
    'chipnet'
  );
  expect(state.approve).toHaveBeenCalledWith(
    expect.objectContaining({ sessionGeneration: 3 }),
    false
  );
  expect(state.send).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Confirm publication' }));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('storage full')
  );
  expect(state.send).not.toHaveBeenCalled();
  state.failSave = false;
  await user.click(screen.getByRole('button', { name: 'Confirm publication' }));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent(
      'submitted; confirmation pending'
    )
  );
  expect(state.events).toEqual(['saved', 'sent']);
  expect(state.send).toHaveBeenCalledOnce();
  expect(state.send).toHaveBeenCalledWith('0102', expect.any(Array), {
    walletId: 7,
  });
});

/**
 * Tests for invoice line-item description formatting.
 *
 * Specifically locks in the "<0.001 GB" presentation for small-but-nonzero
 * bandwidth: at 3-decimal GB precision, anything under ~500 KB would round
 * to "0.000 GB" and become visually indistinguishable from true zero usage.
 * The "<" prefix disambiguates that.
 */

import { describe, it, expect } from 'vitest';
import { formatLineItemDescription } from './formatting';
import { SERVICE_TYPE, INVOICE_LINE_ITEM_TYPE } from '../constants';
import type { InvoiceLineItem } from '../types';

function bandwidthItem(quantityBytes: number): Omit<InvoiceLineItem, 'amountUsd'> {
  return {
    service: SERVICE_TYPE.GRPC,
    itemType: INVOICE_LINE_ITEM_TYPE.BANDWIDTH,
    quantity: quantityBytes,
    unitPriceUsd: 0.06,
  };
}

describe('formatLineItemDescription bandwidth (GB)', () => {
  const opts = { includeServicePrefix: false };

  it('renders 0 bytes as plain "0.000 GB" (true zero — no <)', () => {
    expect(formatLineItemDescription(bandwidthItem(0), opts))
      .toBe('0.000 GB @ $0.06/GB');
  });

  it('renders small nonzero (~15 KB) as "<0.001 GB" so zero and trace usage are distinguishable', () => {
    // 15032 bytes = ~1.4e-5 GB; at 3-decimal precision it rounds to 0.000.
    // Must show "<0.001 GB" so the user can see it is NOT actually zero.
    expect(formatLineItemDescription(bandwidthItem(15032), opts))
      .toBe('<0.001 GB @ $0.06/GB');
  });

  it('renders mid-range (500 MiB) with normal GB precision', () => {
    // 500 MiB / (1024^3) = 0.488... GB — well above the "<0.001" threshold.
    expect(formatLineItemDescription(bandwidthItem(500 * 1024 * 1024), opts))
      .toBe('0.488 GB @ $0.06/GB');
  });

  it('renders ~500 KB (the boundary) as "<0.001 GB"', () => {
    // 500 KB = 4.66e-4 GB, rounds to 0.000 → "<" prefix.
    expect(formatLineItemDescription(bandwidthItem(500 * 1024), opts))
      .toBe('<0.001 GB @ $0.06/GB');
  });

  it('renders ~1 MB as normal "0.001 GB" (just above the threshold)', () => {
    // 1 MB = 0.000931 GB → "0.001" after rounding → no "<" prefix.
    expect(formatLineItemDescription(bandwidthItem(1024 * 1024), opts))
      .toBe('0.001 GB @ $0.06/GB');
  });

  it('renders multi-GB normally', () => {
    expect(formatLineItemDescription(bandwidthItem(2 * 1024 * 1024 * 1024), opts))
      .toBe('2.000 GB @ $0.06/GB');
  });
});

/**
 * Stripe Card Collection Dialog
 *
 * Uses real Stripe Elements (PaymentElement) when STRIPE_PUBLISHABLE_KEY is configured.
 * The same code runs in development (test keys) and production (live keys).
 * Falls back to a pre-filled test card dialog only when no key is available (CI/mock mode).
 */

import { useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import type { Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { OKButton } from './ui/ok-button';
import { CancelButton } from './ui/cancel-button';
import { AlertCircle, CreditCard } from 'lucide-react';
import { stripePublishableKey } from '@/lib/config';

interface StripeCardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientSecret: string;
  setupIntentId: string;
  onSuccess: () => void;
}

// Lazy singleton for Stripe.js — created once on first use
let stripePromise: Promise<Stripe | null> | null = null;
function getStripe(): Promise<Stripe | null> | null {
  if (!stripePromise && stripePublishableKey) {
    stripePromise = loadStripe(stripePublishableKey);
  }
  return stripePromise;
}

export function StripeCardDialog({ open, onOpenChange, clientSecret, setupIntentId, onSuccess }: StripeCardDialogProps) {
  if (stripePublishableKey) {
    return (
      <StripeElementsDialog
        open={open}
        onOpenChange={onOpenChange}
        clientSecret={clientSecret}
        onSuccess={onSuccess}
      />
    );
  }

  return (
    <MockCardDialog
      open={open}
      onOpenChange={onOpenChange}
      setupIntentId={setupIntentId}
      onSuccess={onSuccess}
    />
  );
}

/**
 * Real Stripe Elements dialog.
 * Wraps the form in <Elements> provider which initializes Stripe.js with the SetupIntent clientSecret.
 * Identical code path for dev (pk_test_*) and production (pk_live_*).
 */
function StripeElementsDialog({
  open,
  onOpenChange,
  clientSecret,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientSecret: string;
  onSuccess: () => void;
}) {
  const stripe = getStripe();
  if (!clientSecret || !stripe) return null;

  return (
    <Elements
      stripe={stripe}
      options={{
        clientSecret,
        appearance: {
          theme: 'stripe',
          variables: { colorPrimary: '#7c3aed' },
        },
      }}
      key={clientSecret}
    >
      <CardSetupForm open={open} onOpenChange={onOpenChange} onSuccess={onSuccess} />
    </Elements>
  );
}

/**
 * Inner form rendered inside <Elements>.
 * Uses useStripe/useElements hooks and renders PaymentElement for card input.
 */
function CardSetupForm({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!stripe || !elements) return;

    setError('');
    setSubmitting(true);

    try {
      const { error: confirmError, setupIntent } = await stripe.confirmSetup({
        elements,
        redirect: 'if_required',
        confirmParams: {
          return_url: `${window.location.origin}/billing`,
        },
      });

      if (confirmError) {
        setError(confirmError.message || 'Card setup failed');
        return;
      }

      if (setupIntent?.status === 'succeeded' || setupIntent?.status === 'processing') {
        onSuccess();
      } else {
        setError('Card setup could not be completed. Please try again.');
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!submitting) onOpenChange(v); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Credit Card</DialogTitle>
          <DialogDescription>Card details are collected and secured by Stripe.</DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <PaymentElement options={{
            layout: { type: 'accordion', defaultCollapsed: false, radios: false },
            wallets: { link: 'never' },
          }} />
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
            <AlertCircle className="w-4 h-4" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter>
          <CancelButton disabled={submitting} onClick={() => onOpenChange(false)}>Cancel</CancelButton>
          <OKButton onClick={handleSubmit} disabled={submitting || !stripe || !elements}>
            {submitting ? 'Processing...' : 'Add Card'}
          </OKButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Mock card dialog — fallback when no Stripe publishable key is configured.
 * Shows pre-filled test card and calls the test endpoint to simulate the webhook.
 */
function MockCardDialog({
  open,
  onOpenChange,
  setupIntentId,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setupIntentId: string;
  onSuccess: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    setError('');
    setSubmitting(true);

    try {
      const response = await fetch('/test/stripe/complete-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupIntentId }),
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Setup failed');
      }

      onSuccess();
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!submitting) onOpenChange(v); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Credit Card</DialogTitle>
          <DialogDescription>Mock mode — card details are pre-filled for testing.</DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-3">
          <div className="flex items-center gap-3 p-4 bg-gray-50 border rounded-lg">
            <CreditCard className="w-8 h-8 text-purple-600" />
            <div>
              <div className="text-sm font-medium">Test Card</div>
              <div className="text-sm text-gray-500 font-mono">4242 4242 4242 4242</div>
              <div className="text-xs text-gray-400">Exp: 12/27 &middot; CVC: 123</div>
            </div>
          </div>
          <p className="text-xs text-gray-400">
            Mock mode: card details are pre-filled for testing.
          </p>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
            <AlertCircle className="w-4 h-4" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter>
          <CancelButton disabled={submitting} onClick={() => onOpenChange(false)}>Cancel</CancelButton>
          <OKButton onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Processing...' : 'Add Card'}
          </OKButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

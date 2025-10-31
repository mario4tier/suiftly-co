import { test, expect } from '@playwright/test';

test('debug item width with chevron', async ({ page }) => {
  await page.goto('http://localhost:5173/login');

  // Mock wallet authentication
  await page.evaluate(() => {
    const mockWallet = {
      name: 'Mock Wallet',
      version: '1.0.0',
      accounts: [{
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
        publicKey: new Uint8Array(32),
        chains: ['sui:testnet'],
        features: ['sui:signAndExecuteTransactionBlock']
      }]
    };
    (window as any)['mock-wallet'] = mockWallet;
  });

  await page.click('button:has-text("Mock Wallet")');
  await page.waitForURL('**/dashboard');

  // Find the Seal parent item (with chevron)
  const sealParent = page.locator('div.group:has-text("Seal")').first();
  await sealParent.waitFor();

  console.log('\n=== Parent Item Width Debug ===');

  const box = await sealParent.boundingBox();
  console.log('Seal parent bounding box:', box);

  const styles = await sealParent.evaluate(el => {
    const styles = window.getComputedStyle(el);
    return {
      width: styles.width,
      paddingLeft: styles.paddingLeft,
      paddingRight: styles.paddingRight,
      boxSizing: styles.boxSizing
    };
  });
  console.log('Seal parent computed styles:', styles);

  // Get icon box
  const iconBox = sealParent.locator('div.w-\\[55px\\]').first();
  const iconBoundingBox = await iconBox.boundingBox();
  console.log('Icon container bounding box:', iconBoundingBox);

  // Get chevron box
  const chevronBox = sealParent.locator('span.w-9').first();
  const chevronBoundingBox = await chevronBox.boundingBox();
  console.log('Chevron container bounding box:', chevronBoundingBox);

  // Calculate total width
  if (box && iconBoundingBox && chevronBoundingBox) {
    const totalContentWidth = (chevronBoundingBox.x + chevronBoundingBox.width) - box.x;
    console.log('\nTotal content width (from left edge to chevron right edge):', totalContentWidth);
    console.log('Expected max width: 255px');
    console.log('Overflow:', totalContentWidth > 255 ? `${totalContentWidth - 255}px` : 'None');
  }
});

import { test, expect } from '@playwright/test';

test('debug chevron size and hover', async ({ page }) => {
  // Navigate to dashboard (with mock auth)
  await page.goto('http://localhost:22710/login');

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

  // Find the Seal item with chevron
  const sealItem = page.locator('text=Seal').first();
  await sealItem.waitFor();

  // Get the parent div that should have the chevron
  const parentDiv = sealItem.locator('xpath=ancestor::div[contains(@class, "group")]').first();

  // Find the chevron span
  const chevronSpan = parentDiv.locator('span.w-\\[36px\\]');

  console.log('\n=== Chevron Span Debug ===');

  // Check if chevron span exists
  const chevronExists = await chevronSpan.count();
  console.log('Chevron span count:', chevronExists);

  if (chevronExists > 0) {
    // Get computed styles
    const box = await chevronSpan.boundingBox();
    console.log('Chevron bounding box:', box);

    const width = await chevronSpan.evaluate(el => {
      const styles = window.getComputedStyle(el);
      return {
        width: styles.width,
        height: styles.height,
        display: styles.display,
        alignItems: styles.alignItems,
        justifyContent: styles.justifyContent
      };
    });
    console.log('Chevron computed styles:', width);

    // Get the SVG inside
    const svg = chevronSpan.locator('svg');
    const svgBox = await svg.boundingBox();
    console.log('SVG bounding box:', svgBox);

    const svgStyles = await svg.evaluate(el => {
      const styles = window.getComputedStyle(el);
      return {
        width: styles.width,
        height: styles.height,
        fill: styles.fill
      };
    });
    console.log('SVG computed styles:', svgStyles);

    // Get span background before hover
    const spanBgBefore = await chevronSpan.evaluate(el => {
      const styles = window.getComputedStyle(el);
      return styles.backgroundColor;
    });
    console.log('Span background before hover:', spanBgBefore);

    // Test hover
    console.log('\n=== Testing Hover ===');
    await parentDiv.hover();
    await page.waitForTimeout(100); // Wait for transition

    const spanBgAfter = await chevronSpan.evaluate(el => {
      const styles = window.getComputedStyle(el);
      return styles.backgroundColor;
    });
    console.log('Span background after hover:', spanBgAfter);
  }

  // Also check the parent item classes
  const parentClasses = await parentDiv.getAttribute('class');
  console.log('\nParent div classes:', parentClasses);

  // Check if w-9 and pl-7 work in Tailwind config
  const testUtilities = await page.evaluate(() => {
    const divW9 = document.createElement('div');
    divW9.className = 'w-9';
    document.body.appendChild(divW9);
    const w9Width = window.getComputedStyle(divW9).width;
    divW9.remove();

    const divPl7 = document.createElement('div');
    divPl7.className = 'pl-7';
    document.body.appendChild(divPl7);
    const pl7Padding = window.getComputedStyle(divPl7).paddingLeft;
    divPl7.remove();

    return { w9Width, pl7Padding };
  });
  console.log('\nTest w-9 width:', testUtilities.w9Width);
  console.log('Test pl-7 padding-left:', testUtilities.pl7Padding);
});

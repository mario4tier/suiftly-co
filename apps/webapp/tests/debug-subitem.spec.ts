import { test, expect } from '@playwright/test';

test('debug subitem padding', async ({ page }) => {
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

  // Click on Seal to expand subitems - click the parent div with group class
  const sealParent = page.locator('div.group:has-text("Seal")').first();
  await sealParent.click();

  // Wait for subitem to appear
  const configItem = page.locator('a:has-text("Config")').first();
  await configItem.waitFor({ timeout: 5000 });

  console.log('\n=== Subitem Debug ===');

  // Get the subitem link element
  const box = await configItem.boundingBox();
  console.log('Config item bounding box:', box);

  const styles = await configItem.evaluate(el => {
    const styles = window.getComputedStyle(el);
    return {
      paddingLeft: styles.paddingLeft,
      marginLeft: styles.marginLeft,
      width: styles.width,
      height: styles.height
    };
  });
  console.log('Config item computed styles:', styles);

  // Get the parent container with pl-7
  const parentContainer = configItem.locator('xpath=ancestor::div[contains(@class, "pl-7")]').first();
  const parentExists = await parentContainer.count();
  console.log('Parent container with pl-7 count:', parentExists);

  if (parentExists > 0) {
    const parentStyles = await parentContainer.evaluate(el => {
      const styles = window.getComputedStyle(el);
      return {
        paddingLeft: styles.paddingLeft
      };
    });
    console.log('Parent container padding-left:', parentStyles);
  }

  // Check the classes on the config item
  const classes = await configItem.getAttribute('class');
  console.log('\nConfig item classes:', classes);

  // Test pl-7 utility
  const testDiv = await page.evaluate(() => {
    const div = document.createElement('div');
    div.className = 'pl-7';
    document.body.appendChild(div);
    const padding = window.getComputedStyle(div).paddingLeft;
    div.remove();
    return padding;
  });
  console.log('\nTest pl-7 padding-left:', testDiv);
});

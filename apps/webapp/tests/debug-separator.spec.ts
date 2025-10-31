import { test } from '@playwright/test';

test('debug separator HTML', async ({ page }) => {
  await page.goto('http://localhost:5173/dashboard');
  await page.waitForSelector('aside');

  // Get the entire sidebar HTML
  const sidebarHTML = await page.locator('aside nav').innerHTML();
  console.log('=== SIDEBAR HTML ===');
  console.log(sidebarHTML);

  // Look for dividers specifically
  const dividers = await page.locator('aside nav div.border-t').all();
  console.log(`\n=== FOUND ${dividers.length} DIVIDERS ===`);

  for (let i = 0; i < dividers.length; i++) {
    const classes = await dividers[i].getAttribute('class');
    console.log(`Divider ${i}: ${classes}`);
  }

  // Get computed styles of the divider
  if (dividers.length > 0) {
    const borderColor = await dividers[0].evaluate(el => {
      return window.getComputedStyle(el).borderTopColor;
    });
    const borderWidth = await dividers[0].evaluate(el => {
      return window.getComputedStyle(el).borderTopWidth;
    });
    console.log(`\nDivider border-top-color: ${borderColor}`);
    console.log(`Divider border-top-width: ${borderWidth}`);
  }
});

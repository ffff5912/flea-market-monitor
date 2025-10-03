const puppeteer = require('puppeteer');
const { Client } = require('pg');

const KEYWORDS = [
  'ゲーム'
];

async function scrape() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  for (const keyword of KEYWORDS) {
    console.log(`[メルカリ] ${keyword} をスクレイピング中...`);

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    const url = `https://jp.mercari.com/search?keyword=${encodeURIComponent(keyword)}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('[data-testid="item-cell"]', { timeout: 10000 });

    const products = await page.evaluate(() => {
      const items = [];
      const elements = document.querySelectorAll('[data-testid="item-cell"]');

      elements.forEach((el, idx) => {
        if (idx >= 30) return;
        try {
          const title = el.querySelector('[data-testid="item-name"]')?.textContent?.trim();
          const priceText = el.querySelector('[data-testid="item-price"]')?.textContent;
          const price = parseInt(priceText?.replace(/[^0-9]/g, '') || '0');
          const link = el.querySelector('a')?.getAttribute('href');
          const sold = el.querySelector('[data-testid="item-status"]')?.textContent === 'SOLD';

          if (title && price && link) {
            items.push({
              productId: link.split('/').pop(),
              title,
              price,
              url: 'https://jp.mercari.com' + link,
              status: sold ? 'SOLD' : '販売中'
            });
          }
        } catch (e) {}
      });

      return items;
    });

    for (const p of products) {
      await client.query(`
        INSERT INTO products (source, product_id, title, price, category, status, url, sold_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (source, product_id) DO UPDATE SET
          status = EXCLUDED.status,
          sold_at = CASE WHEN EXCLUDED.status = 'SOLD' AND products.status = '販売中'
            THEN NOW() ELSE products.sold_at END,
          updated_at = NOW()
      `, ['mercari', p.productId, p.title, p.price, keyword, p.status, p.url,
          p.status === 'SOLD' ? new Date() : null]);
    }

    console.log(`[メルカリ] ${products.length}件保存`);
    await page.close();
    await new Promise(r => setTimeout(r, 3000));
  }

  await browser.close();
  await client.end();
}

scrape().catch(console.error);

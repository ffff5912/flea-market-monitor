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
    console.log(`[ヤフーフリマ] ${keyword} をスクレイピング中...`);

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    const url = `https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(keyword)}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('[class*="Product_item"]', { timeout: 10000 });

    const products = await page.evaluate(() => {
      const items = [];
      const elements = document.querySelectorAll('[class*="Product_item"]');

      elements.forEach((el, idx) => {
        if (idx >= 30) return;
        try {
          const titleEl = el.querySelector('[class*="Product_name"]');
          const priceEl = el.querySelector('[class*="Product_price"]');
          const linkEl = el.querySelector('a');
          const soldEl = el.querySelector('[class*="sold"]');

          const title = titleEl?.textContent?.trim();
          const priceText = priceEl?.textContent;
          const price = parseInt(priceText?.replace(/[^0-9]/g, '') || '0');
          const href = linkEl?.getAttribute('href');
          const sold = soldEl !== null;

          if (title && price && href) {
            const productId = href.split('/').pop()?.split('?')[0] || `y_${Date.now()}_${idx}`;
            items.push({
              productId,
              title,
              price,
              url: href.startsWith('http') ? href : 'https://paypayfleamarket.yahoo.co.jp' + href,
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
      `, ['yahoo', p.productId, p.title, p.price, keyword, p.status, p.url,
          p.status === 'SOLD' ? new Date() : null]);
    }

    console.log(`[ヤフーフリマ] ${products.length}件保存`);
    await page.close();
    await new Promise(r => setTimeout(r, 3000));
  }

  await browser.close();
  await client.end();
}

scrape().catch(console.error);

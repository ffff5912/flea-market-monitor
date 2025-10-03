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
    await scrapeByStatus(browser, client, keyword, 'on_sale', '販売中');
    
    await scrapeByStatus(browser, client, keyword, 'sold_out%7Ctrading', 'SOLD');
  }

  await browser.close();
  await client.end();
}

async function scrapeByStatus(browser, client, keyword, statusParam, statusLabel) {
  console.log(`[メルカリ] ${keyword} (${statusLabel}) をスクレイピング中...`);

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

  const url = `https://jp.mercari.com/search?keyword=${encodeURIComponent(keyword)}&sort=created_time&order=desc&status=${statusParam}`;
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('[data-testid="item-cell"]', { timeout: 10000 });

    const products = await page.evaluate(() => {
      const items = [];
      const elements = document.querySelectorAll('[data-testid="item-cell"]');

      elements.forEach((el, idx) => {
        if (idx >= 30) return;
        try {
          const titleEl = el.querySelector('[data-testid="thumbnail-item-name"]');
          const priceEl = el.querySelector('.merPrice .number__6b270ca7');
          const linkEl = el.querySelector('a[data-testid="thumbnail-link"]');

          const title = titleEl?.textContent?.trim();
          const priceText = priceEl?.textContent?.trim();
          const price = parseInt(priceText?.replace(/,/g, '') || '0');
          const href = linkEl?.getAttribute('href');

          if (title && price && href) {
            items.push({
              productId: href.split('/').pop(),
              title,
              price,
              url: 'https://jp.mercari.com' + href
            });
          }
        } catch (e) {
          console.error('Parse error:', e);
        }
      });

      return items;
    });

    for (const p of products) {
      await client.query(`
        INSERT INTO products (source, product_id, title, price, category, status, url, sold_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (source, product_id) DO UPDATE SET
          status = EXCLUDED.status,
          sold_at = CASE 
            WHEN EXCLUDED.status = 'SOLD' AND products.status = '販売中' THEN NOW() 
            WHEN EXCLUDED.status = 'SOLD' THEN products.sold_at
            ELSE NULL 
          END,
          updated_at = NOW()
      `, [
        'mercari', 
        p.productId, 
        p.title, 
        p.price, 
        keyword, 
        statusLabel, 
        p.url,
        statusLabel === 'SOLD' ? new Date() : null
      ]);
    }

    console.log(`[メルカリ] ${keyword} (${statusLabel}) ${products.length}件保存`);
  } catch (error) {
    console.error(`[メルカリ] ${keyword} (${statusLabel}) エラー:`, error.message);
  } finally {
    await page.close();
    await new Promise(r => setTimeout(r, 3000));
  }
}

scrape().catch(console.error);

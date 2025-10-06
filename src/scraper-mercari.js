// scraper-mercari.js（DB分析版 - 全文）
const puppeteer = require('puppeteer');
const { Client } = require('pg');

// DBから売れ筋キーワードを分析
async function analyzeKeywordsFromDB() {
  if (!process.env.DATABASE_URL) {
    console.log('[DB分析] DATABASE_URL未設定 - スキップ');
    return null;
  }

  console.log('[DB分析] 売れ筋キーワードを分析中...');
  
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });
  
  await client.connect();
  
  // SOLD商品から頻出ワードを抽出
  const result = await client.query(`
    SELECT 
      keyword,
      COUNT(*) as sold_count,
      AVG(price) as avg_price,
      MAX(created_at) as last_scraped
    FROM products
    WHERE 
      source = 'mercari' 
      AND status = 'SOLD'
      AND created_at > NOW() - INTERVAL '7 days'  -- 直近7日間
    GROUP BY keyword
    HAVING COUNT(*) > 10  -- 10件以上売れているもの
    ORDER BY sold_count DESC
    LIMIT 10
  `);
  
  await client.end();
  
  if (result.rows.length > 0) {
    const keywords = result.rows.map(r => r.keyword);
    console.log(`[DB分析] ${keywords.length}件のキーワード抽出:`);
    result.rows.forEach(r => {
      console.log(`  - ${r.keyword}: ${r.sold_count}件売れ (平均¥${Math.round(r.avg_price)})`);
    });
    return keywords;
  }
  
  return null;
}

// キーワード取得（優先順位: 環境変数 > DB分析 > デフォルト）
async function getKeywords() {
  // 1. 環境変数（手動指定 - 最優先）
  if (process.env.KEYWORDS) {
    const keywords = process.env.KEYWORDS.split(',').map(k => k.trim());
    console.log(`[キーワード] 環境変数から取得: ${keywords.join(', ')}`);
    return keywords;
  }
  
  // 2. DB分析（自動）
  if (process.env.AUTO_KEYWORD === 'true') {
    try {
      const analyzed = await analyzeKeywordsFromDB();
      if (analyzed && analyzed.length > 0) {
        console.log(`[キーワード] DB分析から取得: ${analyzed.join(', ')}`);
        return analyzed;
      }
    } catch (e) {
      console.error('[DB分析] エラー:', e.message);
    }
  }
  
  // 3. デフォルト
  const defaultKeywords = ['ゲーム'];
  console.log(`[キーワード] デフォルト使用: ${defaultKeywords.join(', ')}`);
  return defaultKeywords;
}

async function scrapeMercari(keyword, status = 'on_sale') {
  console.log(`[メルカリ] ${keyword} (${status}) をスクレイピング中...`);
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  );

  const statusParam = status === 'sold' ? '&status=sold' : '';
  const url = `https://jp.mercari.com/search?keyword=${encodeURIComponent(keyword)}${statusParam}`;
  
  await page.goto(url, { 
    waitUntil: 'networkidle2', 
    timeout: 30000 
  });

  await autoScroll(page, 20);

  const products = await page.evaluate(() => {
    const items = [];
    const links = document.querySelectorAll('a[href^="/item/m"]');
    const seen = new Set();

    links.forEach((link) => {
      const href = link.getAttribute('href');
      const productId = href.split('/').pop();
      
      if (seen.has(productId)) return;
      seen.add(productId);
      
      try {
        const titleEl = link.querySelector('[data-testid="thumbnail-item-name"]');
        let title = titleEl?.textContent?.trim();
        
        if (!title) {
          const ariaLabel = link.getAttribute('aria-label');
          if (ariaLabel) {
            title = ariaLabel.replace(/の画像.*/, '').trim();
          }
        }
        
        if (!title) {
          const img = link.querySelector('img');
          title = img?.getAttribute('alt')?.replace(/のサムネイル$/, '');
        }
        
        const priceEl = link.querySelector('.number__6b270ca7');
        const price = priceEl ? parseInt(priceEl.textContent.replace(/[^0-9]/g, '')) : 0;
        
        if (productId && title && price > 0) {
          items.push({
            productId,
            title: title.trim(),
            price,
            url: 'https://jp.mercari.com' + href,
            status: '販売中'
          });
        }
      } catch (e) {
        console.error('Parse error:', e.message);
      }
    });

    return items;
  });

  await browser.close();

  products.forEach(p => p.status = status === 'sold' ? 'SOLD' : '販売中');

  console.log(`[メルカリ] ${products.length}件取得`);
  
  products.slice(0, 3).forEach(p => {
    console.log(`  - ${p.title.substring(0, 50)}... ¥${p.price.toLocaleString()} [${p.status}]`);
  });

  return products;
}

async function autoScroll(page, maxScrolls = 20) {
  await page.evaluate(async (maxScrolls) => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      let scrolls = 0;
      
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        scrolls++;

        if (totalHeight >= scrollHeight || scrolls >= maxScrolls) {
          clearInterval(timer);
          resolve();
        }
      }, 500);
    });
  }, maxScrolls);
  
  await page.waitForTimeout(2000);
}

async function saveToDatabase(items, keyword) {
  if (!process.env.DATABASE_URL) {
    console.log('[DB] DATABASE_URL未設定 - スキップ');
    return;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });
  
  await client.connect();
  
  for (const item of items) {
    await client.query(`
      INSERT INTO products (
        product_id, title, price, url, source, keyword, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (product_id, source) 
      DO UPDATE SET 
        price = EXCLUDED.price,
        status = EXCLUDED.status,
        updated_at = CURRENT_TIMESTAMP
    `, [
      item.productId,
      item.title,
      item.price,
      item.url,
      'mercari',
      keyword,
      item.status,
      new Date()
    ]);
  }
  
  await client.end();
  console.log(`[DB] ${items.length}件保存完了`);
}

// メイン実行
(async () => {
  const KEYWORDS = await getKeywords();
  
  for (const keyword of KEYWORDS) {
    const onSaleItems = await scrapeMercari(keyword, 'on_sale');
    await saveToDatabase(onSaleItems, keyword);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const soldItems = await scrapeMercari(keyword, 'sold');
    await saveToDatabase(soldItems, keyword);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  
  console.log('\n完了!');
  process.exit(0);
})();
